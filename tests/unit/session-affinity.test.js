import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => new Map());
const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getSettings: vi.fn(),
  updateProviderConnection: vi.fn(),
}));

// In-memory stand-in for the SQLite kv table used by sessionAffinity.js.
vi.mock("@/lib/db/driver.js", () => {
  const k = (scope, key) => `${scope}\u0000${key}`;
  const db = {
    get: (_sql, [scope, key]) => (store.has(k(scope, key)) ? { value: store.get(k(scope, key)) } : undefined),
    all: (_sql, [scope]) => [...store.entries()]
      .filter(([key]) => key.startsWith(`${scope}\u0000`))
      .map(([key, value]) => ({ key: key.split("\u0000")[1], value })),
    run: (sql, params) => {
      if (sql.startsWith("DELETE")) store.delete(k(params[0], params[1]));
      else store.set(k(params[0], params[1]), params[2]);
      return { changes: 1 };
    },
    transaction: (fn) => fn(),
  };
  return { getAdapter: async () => db };
});
vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getSettings: mocks.getSettings,
  getProxyPools: vi.fn(),
  validateApiKey: vi.fn(),
  updateProviderConnection: mocks.updateProviderConnection,
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({})),
  pickProxyPoolId: vi.fn(),
}));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {},
  resolveProviderId: (provider) => provider,
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));

const affinity = await import("@/sse/services/sessionAffinity.js");
const { getProviderCredentials } = await import("@/sse/services/auth.js");

const headers = (h) => new Headers(h);
const conn = (id, extra = {}) => ({ id, provider: "codex", isActive: true, ...extra });
let logSpy;

function events() {
  return logSpy.mock.calls
    .map(([line]) => { try { return JSON.parse(line); } catch { return null; } })
    .filter((e) => e?.event?.startsWith("affinity_"));
}

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
  affinity.__resetAffinitySweepForTests();
  delete process.env.NINEROUTER_SESSION_AFFINITY_TTL_MS;
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  // Round-robin with a sticky limit of 1 rotates every request without affinity.
  mocks.getSettings.mockResolvedValue({ fallbackStrategy: "round-robin", stickyRoundRobinLimit: 1 });
  const connections = [conn("conn-aaaa-1111"), conn("conn-bbbb-2222")];
  mocks.getProviderConnections.mockImplementation(async () => connections);
  mocks.updateProviderConnection.mockImplementation(async (id, update) => {
    Object.assign(connections.find((c) => c.id === id), update);
  });
});
afterEach(() => logSpy.mockRestore());

describe("session key extraction", () => {
  it("uses headers in priority order, then body fields", () => {
    expect(affinity.extractSessionKey(headers({ "x-session-id": "s2", "x-codex-session-id": "s1" }), {})).toBe("s1");
    expect(affinity.extractSessionKey(headers({ "x-9router-session": "s3" }), { session_id: "b" })).toBe("s3");
    expect(affinity.extractSessionKey(headers({}), { metadata: { session_id: "m" }, conversation_id: "c" })).toBe("m");
    expect(affinity.extractSessionKey(headers({}), { conversation_id: "c", session_id: "s" })).toBe("c");
    expect(affinity.extractSessionKey(headers({}), { session_id: "s", prompt_cache_key: "p" })).toBe("s");
    expect(affinity.extractSessionKey(headers({}), { prompt_cache_key: "p" })).toBe("p");
    expect(affinity.extractSessionKey(headers({}), { input: "hi" })).toBeNull();
  });

  it("detects encrypted_content only in structured request fields", () => {
    expect(affinity.containsEncryptedContent({ input: [{ type: "reasoning", encrypted_content: "x" }] })).toBe(true);
    expect(affinity.containsEncryptedContent({ messages: [{ role: "assistant", reasoning_encrypted_content: "x" }] })).toBe(true);
    expect(affinity.containsEncryptedContent({ input: [{ role: "user", content: "encrypted_content" }] })).toBe(false);
  });

  it("stores only a hash, scoped by API key and provider", () => {
    const a = affinity.affinityIdentity("sess", "codex", "key-1");
    expect(a.key).not.toContain("sess");
    expect(a.key).not.toContain("key-1");
    expect(affinity.affinityIdentity("sess", "codex", "key-2").key).not.toBe(a.key);
    expect(affinity.affinityIdentity("sess", "claude", "key-1").key).not.toBe(a.key);
  });

  it("reads TTL from env, then settings, defaulting to 24h", () => {
    expect(affinity.affinityTtlMs({})).toBe(86_400_000);
    expect(affinity.affinityTtlMs({ sessionAffinityTtlMs: 0 })).toBe(0);
    process.env.NINEROUTER_SESSION_AFFINITY_TTL_MS = "60000";
    expect(affinity.affinityTtlMs({ sessionAffinityTtlMs: 0 })).toBe(60_000);
  });
});

describe("getProviderCredentials affinity", () => {
  const opts = { sessionKey: "codex-session-1", apiKey: "k", requestId: "req-1" };

  it("creates a pin then keeps hitting it beyond the round-robin sticky limit", async () => {
    const first = await getProviderCredentials("codex", null, "gpt-5.5", opts);
    expect(first.affinity).toBe("created");
    for (let i = 0; i < 5; i++) {
      const next = await getProviderCredentials("codex", null, "gpt-5.5", opts);
      expect(next.affinity).toBe("hit");
      expect(next.connectionId).toBe(first.connectionId);
    }
    // Without a session the stock strategy still rotates.
    const other = await getProviderCredentials("codex", null, "gpt-5.5", {});
    expect(other.affinity).toBe("none");
    expect(other.connectionId).not.toBe(first.connectionId);

    const evs = events();
    expect(evs[0]).toMatchObject({ event: "affinity_created", provider: "codex", request_id: "req-1",
      connection_id: first.connectionId.slice(0, 8) });
    expect(evs[0].session_key_hash).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.stringify(evs)).not.toContain("codex-session-1");
    expect(evs.filter((e) => e.event === "affinity_hit")).toHaveLength(5);
  });

  it("clears a pin to a model-locked account and repins for normal requests", async () => {
    const first = await getProviderCredentials("codex", null, "gpt-5.5", opts);
    const conns = await mocks.getProviderConnections();
    conns.find((c) => c.id === first.connectionId)["modelLock_gpt-5.5"] = new Date(Date.now() + 60_000).toISOString();

    const next = await getProviderCredentials("codex", null, "gpt-5.5", opts);
    expect(next.connectionId).not.toBe(first.connectionId);
    expect(next.affinity).toBe("created");
    expect(events()).toContainEqual(expect.objectContaining({ event: "affinity_cleared", reason: "unavailable_or_locked" }));
  });

  it("fails closed for encrypted_content when the pinned account is excluded", async () => {
    const first = await getProviderCredentials("codex", null, "gpt-5.5", opts);
    const result = await getProviderCredentials("codex", new Set([first.connectionId]), "gpt-5.5",
      { ...opts, encryptedContent: true });
    expect(result).toMatchObject({ affinityUnavailable: true, reason: "pinned account excluded" });
    expect(events().map((e) => e.event)).toEqual(["affinity_created", "affinity_cleared", "affinity_unavailable"]);
  });

  it("fails closed for encrypted_content when the pinned account is model-locked", async () => {
    const first = await getProviderCredentials("codex", null, "gpt-5.5", opts);
    const conns = await mocks.getProviderConnections();
    conns.find((c) => c.id === first.connectionId)["modelLock_gpt-5.5"] = new Date(Date.now() + 60_000).toISOString();
    const result = await getProviderCredentials("codex", null, "gpt-5.5", { ...opts, encryptedContent: true });
    expect(result).toMatchObject({ affinityUnavailable: true, reason: "pinned account unavailable_or_locked" });
  });

  it("fails closed for encrypted_content when the pinned account was deactivated", async () => {
    const first = await getProviderCredentials("codex", null, "gpt-5.5", opts);
    mocks.getProviderConnections.mockResolvedValue([]);
    const result = await getProviderCredentials("codex", null, "gpt-5.5", { ...opts, encryptedContent: true });
    expect(result).toMatchObject({ affinityUnavailable: true });
    expect(events()).toContainEqual(expect.objectContaining({ event: "affinity_cleared",
      connection_id: first.connectionId.slice(0, 8) }));
  });

  it("fails closed for encrypted_content without an existing pin", async () => {
    const result = await getProviderCredentials("codex", null, "gpt-5.5", { ...opts, encryptedContent: true });
    expect(result).toMatchObject({ affinityUnavailable: true, reason: "encrypted_content without an active pin" });
    expect(events()).toEqual([expect.objectContaining({ event: "affinity_unavailable",
      reason: "encrypted_content_without_pin", connection_id: null })]);
    expect(store.size).toBe(0);
    const first = await getProviderCredentials("codex", null, "gpt-5.5", opts);
    const next = await getProviderCredentials("codex", null, "gpt-5.5", { ...opts, encryptedContent: true });
    expect(next).toMatchObject({ affinity: "hit", connectionId: first.connectionId });
  });

  it("fails closed for encrypted_content after TTL expiry", async () => {
    mocks.getSettings.mockResolvedValue({ fallbackStrategy: "fill-first", sessionAffinityTtlMs: 1000 });
    vi.useFakeTimers();
    try {
      await getProviderCredentials("codex", null, "gpt-5.5", opts);
      vi.advanceTimersByTime(1001);
      const next = await getProviderCredentials("codex", null, "gpt-5.5", { ...opts, encryptedContent: true });
      expect(next).toMatchObject({ affinityUnavailable: true, reason: "encrypted_content without an active pin" });
      expect(events()).toContainEqual(expect.objectContaining({ event: "affinity_cleared", reason: "expired" }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed for encrypted_content without a session key", async () => {
    const r = await getProviderCredentials("codex", null, "gpt-5.5", { apiKey: "k", encryptedContent: true });
    expect(r).toMatchObject({ affinityUnavailable: true });
    expect(store.size).toBe(0);
  });

  it("expires pins after the TTL", async () => {
    mocks.getSettings.mockResolvedValue({ fallbackStrategy: "fill-first", sessionAffinityTtlMs: 1000 });
    vi.useFakeTimers();
    try {
      await getProviderCredentials("codex", null, "gpt-5.5", opts);
      vi.advanceTimersByTime(1001);
      const next = await getProviderCredentials("codex", null, "gpt-5.5", opts);
      expect(next.affinity).toBe("created");
      expect(events()).toContainEqual(expect.objectContaining({ event: "affinity_cleared", reason: "expired" }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("is disabled when TTL is 0", async () => {
    mocks.getSettings.mockResolvedValue({ sessionAffinityTtlMs: 0 });
    const r = await getProviderCredentials("codex", null, "gpt-5.5", { ...opts, encryptedContent: true });
    expect(r.affinity).toBe("none");
    expect(store.size).toBe(0);
  });

  it("does not clear a newer pin when a stale connection fails", async () => {
    const identity = affinity.affinityIdentity("s", "codex", "k");
    await affinity.setPin(identity, "conn-new", 60_000);
    expect(await affinity.clearPin(identity, "conn-old")).toBe(false);
    expect((await affinity.readPin(identity)).connectionId).toBe("conn-new");
  });
});

describe("response helpers", () => {
  it("adds truncated connection id and affinity status headers", () => {
    const res = affinity.withAffinityHeaders(new Response("ok", { status: 200 }),
      { connectionId: "conn-aaaa-1111", affinity: "hit" });
    expect(res.headers.get("x-9router-connection-id")).toBe("conn-aaa");
    expect(res.headers.get("x-9router-affinity")).toBe("hit");
  });

  it("returns a clear 409 for unavailable encrypted-content affinity", async () => {
    const res = affinity.affinityUnavailableResponse("pinned account failed with upstream 429");
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("session_affinity_unavailable");
    expect(body.error.message).toContain("upstream 429");
  });
});
