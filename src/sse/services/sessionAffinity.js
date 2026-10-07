import { createHash } from "node:crypto";
import { getAdapter } from "@/lib/db/driver.js";
import { resolveProviderId } from "@/shared/constants/providers.js";

const SCOPE = "sessionAccountAffinity";
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

export async function readPin(identity, now = Date.now()) {
  const db = await getAdapter();
  const row = db.get("SELECT value FROM kv WHERE scope = ? AND key = ?", [SCOPE, identity.key]);
  if (!row) return null;
  let pin;
  try { pin = JSON.parse(row.value); } catch { /* corrupt/old record */ }
  if (!pin?.connectionId || !Number.isFinite(pin.expiresAt) || pin.expiresAt <= now) {
    db.run("DELETE FROM kv WHERE scope = ? AND key = ?", [SCOPE, identity.key]);
    return { expired: true, connectionId: pin?.connectionId || null };
  }
  return pin;
}

const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
let nextSweepAt = 0;

// Bound table growth from sessions that are never resumed.
function sweepExpired(db, now) {
  if (now < nextSweepAt) return;
  nextSweepAt = now + SWEEP_INTERVAL_MS;
  const expired = db.all("SELECT key, value FROM kv WHERE scope = ?", [SCOPE]).filter((row) => {
    try { return !(JSON.parse(row.value)?.expiresAt > now); } catch { return true; }
  });
  if (expired.length === 0) return;
  db.transaction(() => {
    for (const row of expired) db.run("DELETE FROM kv WHERE scope = ? AND key = ?", [SCOPE, row.key]);
  });
}

export async function setPin(identity, connectionId, ttl, now = Date.now()) {
  const db = await getAdapter();
  sweepExpired(db, now);
  db.run("INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value", [
    SCOPE, identity.key, JSON.stringify({ connectionId, expiresAt: now + ttl }),
  ]);
}

// Conditional deletion prevents a late failed request from clearing a newer pin.
export async function clearPin(identity, connectionId) {
  const db = await getAdapter();
  const row = db.get("SELECT value FROM kv WHERE scope = ? AND key = ?", [SCOPE, identity.key]);
  if (!row) return false;
  let pin;
  try { pin = JSON.parse(row.value); } catch { /* corrupt record */ }
  if (connectionId && pin?.connectionId !== connectionId) return false;
  db.run("DELETE FROM kv WHERE scope = ? AND key = ?", [SCOPE, identity.key]);
  return true;
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

export function affinityUnavailableResponse(detail = "") {
  const suffix = detail ? ` (${String(detail).replace(/[\r\n]/g, " ").slice(0, 200)})` : "";
  return new Response(JSON.stringify({ error: { code: "session_affinity_unavailable", type: "invalid_request_error",
    message: `Encrypted content requires its original pinned account; no usable session pin is available. Start a new session.${suffix}` } }),
    { status: 409, headers: { "Content-Type": "application/json", "x-9router-affinity": "none" } });
}

export function __resetAffinitySweepForTests() { nextSweepAt = 0; }
