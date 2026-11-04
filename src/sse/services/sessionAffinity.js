import { createHash } from "node:crypto";
import { getAdapter } from "@/lib/db/driver.js";
import { resolveProviderId } from "@/shared/constants/providers.js";

const SCOPE = "sessionAccountAffinity";
const OWNER_SCOPE = "sessionAccountOwner";
export const DEFAULT_AFFINITY_TTL_MS = 24 * 60 * 60 * 1000;

function sessionValue(value) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 512) : null;
}

export function extractSessionKey(headers, body) {
  for (const header of ["x-codex-session-id", "x-session-id", "x-9router-session"]) {
    const value = sessionValue(headers?.get?.(header));
    if (value) return value;
  }
  for (const value of [body?.metadata?.session_id, body?.conversation_id, body?.session_id, body?.prompt_cache_key]) {
    const key = sessionValue(value);
    if (key) return key;
  }
  return null;
}

// Examine structured fields only; never search arbitrary user text for the marker.
export function containsEncryptedContent(body) {
  const seen = new WeakSet();
  const visit = (value, depth = 0) => {
    if (!value || typeof value !== "object" || depth > 24 || seen.has(value)) return false;
    seen.add(value);
    if (typeof value.encrypted_content === "string" && value.encrypted_content.length > 0) return true;
    if (typeof value.reasoning_encrypted_content === "string" && value.reasoning_encrypted_content.length > 0) return true;
    return Object.values(value).some((child) => typeof child === "object" && visit(child, depth + 1));
  };
  return visit(body?.input) || visit(body?.messages) || visit(body?.output);
}

export function affinityIdentity(sessionKey, provider, apiKey = "") {
  if (!sessionKey) return null;
  const providerId = resolveProviderId(provider);
  // Scope the pin to the calling key and provider; store neither key nor raw session ID.
  const sessionHash = createHash("sha256").update(JSON.stringify([apiKey, sessionKey])).digest("hex");
  return { key: `${providerId}:${sessionHash}`, sessionHash: sessionHash.slice(0, 12), provider: providerId };
}

export function affinityTtlMs(settings) {
  const raw = process.env.NINEROUTER_SESSION_AFFINITY_TTL_MS ?? settings?.sessionAffinityTtlMs ?? DEFAULT_AFFINITY_TTL_MS;
  const ttl = Number(raw);
  return Number.isSafeInteger(ttl) && ttl >= 0 && ttl <= 86_400_000 ? ttl : DEFAULT_AFFINITY_TTL_MS;
}

function validConnectionId(connectionId) {
  return typeof connectionId === "string" && connectionId.length > 0 && connectionId.length <= 512;
}

function parseOwner(row) {
  if (!row) return null;
  try {
    const owner = JSON.parse(row.value);
    if (owner?.version === 1 && validConnectionId(owner.connectionId)
        && Number.isSafeInteger(owner.createdAt) && owner.createdAt >= 0) return owner;
  } catch { /* malformed ownership must not be replaced */ }
  return { invalid: true };
}

function readOwnerFromDb(db, identity) {
  return parseOwner(db.get("SELECT value FROM kv WHERE scope = ? AND key = ?", [OWNER_SCOPE, identity.key]));
}

// Read-only diagnostic: neither an expired lease nor a malformed owner may be deleted here.
export async function readOwner(identity) {
  const db = await getAdapter();
  return readOwnerFromDb(db, identity);
}

export async function readPin(identity, now = Date.now()) {
  const db = await getAdapter();
  const row = db.get("SELECT value FROM kv WHERE scope = ? AND key = ?", [SCOPE, identity.key]);
  if (!row) return null;
  let pin;
  try { pin = JSON.parse(row.value); } catch { /* retain malformed legacy evidence */ }
  if (!validConnectionId(pin?.connectionId) || !Number.isFinite(pin.expiresAt)) return { invalid: true };
  return { ...pin, ...(pin.expiresAt <= now ? { expired: true } : {}) };
}

function insertOwner(db, identity, connectionId, now) {
  return db.run("INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO NOTHING", [
    OWNER_SCOPE, identity.key, JSON.stringify({ version: 1, connectionId, createdAt: now }),
  ]);
}

// Preserve the original account even when the old lease has expired; never sweep evidence
// from other sessions while lazily promoting legacy rows.
export async function resolveOwner(identity, now = Date.now()) {
  const db = await getAdapter();
  // sql.js uses independent in-memory snapshots and debounced file writes. It
  // cannot arbitrate owners across workers or persist a claim before dispatch.
  if (db.driver === "sql.js") throw new Error("Session ownership requires a native SQLite driver");
  const owner = readOwnerFromDb(db, identity);
  if (owner) return owner;
  const row = db.get("SELECT value FROM kv WHERE scope = ? AND key = ?", [SCOPE, identity.key]);
  if (!row) return null;
  let legacy;
  try { legacy = JSON.parse(row.value); } catch { /* malformed legacy evidence */ }
  if (!validConnectionId(legacy?.connectionId) || !Number.isFinite(legacy.expiresAt)) return { invalid: true };
  insertOwner(db, identity, legacy.connectionId, now);
  return readOwnerFromDb(db, identity) || { invalid: true };
}

// SQLite uniqueness, not the process-local selection mutex, arbitrates simultaneous
// first turns in different workers. A losing caller must use the persisted winner.
export async function claimOwner(identity, connectionId, now = Date.now()) {
  const owner = await resolveOwner(identity, now);
  if (owner) return { owner, created: false };
  if (!validConnectionId(connectionId)) return { owner: { invalid: true }, created: false };
  const db = await getAdapter();
  const result = insertOwner(db, identity, connectionId, now);
  return { owner: readOwnerFromDb(db, identity) || { invalid: true }, created: result.changes === 1 };
}

export async function setPin(identity, connectionId, ttl, now = Date.now()) {
  const { owner } = await claimOwner(identity, connectionId, now);
  if (owner.invalid || owner.connectionId !== connectionId) throw new Error("Session account owner mismatch");
  if (ttl <= 0) return;
  const db = await getAdapter();
  db.run("INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value", [
    SCOPE, identity.key, JSON.stringify({ connectionId, expiresAt: now + ttl }),
  ]);
}

// A stale failure may clear only its own lease, never the durable owner or a newer lease.
export async function clearPin(identity, connectionId) {
  const owner = await resolveOwner(identity);
  if (!owner || owner.invalid || (connectionId && owner.connectionId !== connectionId)) return false;
  const db = await getAdapter();
  const row = db.get("SELECT value FROM kv WHERE scope = ? AND key = ?", [SCOPE, identity.key]);
  if (!row) return false;
  let pin;
  try { pin = JSON.parse(row.value); } catch { return false; }
  if (pin?.connectionId !== owner.connectionId) return false;
  return db.run("DELETE FROM kv WHERE scope = ? AND key = ? AND value = ?", [SCOPE, identity.key, row.value]).changes === 1;
}

export function affinityLog(event, identity, connectionId, requestId, reason) {
  console.log(JSON.stringify({ event, router: "ninerouter", session_key_hash: identity?.sessionHash || null,
    provider: identity?.provider || null, connection_id: connectionId?.slice(0, 8) || null,
    request_id: typeof requestId === "string" ? requestId.replace(/[\r\n]/g, "").slice(0, 128) : null,
    ...(reason ? { reason } : {}) }));
}

export function withAffinityHeaders(response, credentials) {
  if (!(response instanceof Response)) return response;
  const headers = new Headers(response.headers);
  headers.set("x-9router-affinity", credentials?.affinity || "none");
  if (credentials?.connectionId && credentials.connectionId !== "noauth") {
    headers.set("x-9router-connection-id", credentials.connectionId.slice(0, 8));
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function affinityUnavailableResponse(detail = "", retryable = false) {
  const suffix = detail ? ` (${String(detail).replace(/[\r\n]/g, " ").slice(0, 200)})` : "";
  const message = retryable
    ? "The original session account is temporarily unavailable. Ownership is retained; retry the same session when the account is available."
    : "No trustworthy original account mapping is available. Restore the original mapping or start a new conversation without old encrypted content.";
  return new Response(JSON.stringify({ error: { code: "session_affinity_unavailable", type: "invalid_request_error",
    message: `${message}${suffix}` } }),
    { status: 409, headers: { "Content-Type": "application/json", "x-9router-affinity": "none" } });
}
