import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => new Map());
const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getSettings: vi.fn(),
  updateProviderConnection: vi.fn(),
}));

// Model SQLite uniqueness and compare-and-delete, not an unconditional Map upsert.
vi.mock("@/lib/db/driver.js", () => {
  const k = (scope, key) => `${scope}\u0000${key}`;
  const db = {
    get: (_sql, [scope, key]) => (store.has(k(scope, key)) ? { value: store.get(k(scope, key)) } : undefined),
    all: (_sql, [scope]) => [...store.entries()]
      .filter(([key]) => key.startsWith(`${scope}\u0000`))
      .map(([key, value]) => ({ key: key.split("\u0000")[1], value })),
    run: (sql, [scope, key, value]) => {
      const id = k(scope, key);
      if (sql.startsWith("DELETE")) {
        if (!store.has(id) || (value !== undefined && store.get(id) !== value)) return { changes: 0 };
        store.delete(id);
      } else {
        if (sql.includes("DO NOTHING") && store.has(id)) return { changes: 0 };
        store.set(id, value);
      }
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
  resolveProviderId: (provider) => provider === "cx" ? "codex" : provider,
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));

const affinity = await import("@/sse/services/sessionAffinity.js");
const { getProviderCredentials } = await import("@/sse/services/auth.js");

const headers = (h) => new Headers(h);
const conn = (id, extra = {}) => ({ id, provider: "codex", isActive: true, ...extra });
const rowKey = (scope, identity) => `${scope}\u0000${identity.key}`;
let logSpy;

function events() {
  return logSpy.mock.calls
    .map(([line]) => { try { return JSON.parse(line); } catch { return null; } })
    .filter((e) => e?.event?.startsWith("affinity_"));
}

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
  delete process.env.NINEROUTER_SESSION_AFFINITY_TTL_MS;
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  mocks.getSettings.mockResolvedValue({ fallbackStrategy: "round-robin", stickyRoundRobinLimit: 1 });
  const connections = [conn("conn-aaaa-1111"), conn("conn-bbbb-2222")];
  mocks.getProviderConnections.mockImplementation(async () => connections);
  mocks.updateProviderConnection.mockImplementation(async (id, update) => {
    Object.assign(connections.find((c) => c.id === id), update);
  });
});
afterEach(() => {
  vi.useRealTimers();
  logSpy.mockRestore();
});

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

  it("stores only a hash, scoped by API key and canonical provider", () => {
    const a = affinity.affinityIdentity("sess", "codex", "key-1");
    expect(a.key).not.toContain("sess");
    expect(a.key).not.toContain("key-1");
    expect(affinity.affinityIdentity("sess", "codex", "key-2").key).not.toBe(a.key);
    expect(affinity.affinityIdentity("sess", "claude", "key-1").key).not.toBe(a.key);
    expect(affinity.affinityIdentity("sess", "cx", "key-1").key).toBe(a.key);
  });

  it("reads lease TTL from env, then settings, defaulting to 24h", () => {
    expect(affinity.affinityTtlMs({})).toBe(86_400_000);
    expect(affinity.affinityTtlMs({ sessionAffinityTtlMs: 0 })).toBe(0);
    process.env.NINEROUTER_SESSION_AFFINITY_TTL_MS = "60000";
    expect(affinity.affinityTtlMs({ sessionAffinityTtlMs: 0 })).toBe(60_000);
  });
});

describe("getProviderCredentials durable affinity", () => {
  const opts = { sessionKey: "codex-session-1", apiKey: "k", requestId: "req-1" };
  const identity = () => affinity.affinityIdentity(opts.sessionKey, "codex", opts.apiKey);

  it("creates an owner then keeps hitting it beyond the round-robin sticky limit", async () => {
    const first = await getProviderCredentials("codex", null, "gpt-5.5", opts);
    expect(first.affinity).toBe("created");
    for (let i = 0; i < 5; i++) {
      const next = await getProviderCredentials("codex", null, "gpt-5.5", opts);
      expect(next).toMatchObject({ affinity: "hit", connectionId: first.connectionId });
    }
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

  it.each([false, true])("retains original owner after seven idle days (encrypted=%s)", async (encryptedContent) => {
    vi.useFakeTimers();
    const first = await getProviderCredentials("codex", null, "gpt-5.5", opts);
    vi.advanceTimersByTime(7 * 86_400_000);
    const next = await getProviderCredentials("codex", null, "gpt-5.5", { ...opts, encryptedContent });
    expect(next).toMatchObject({ affinity: "hit", connectionId: first.connectionId });
    expect(events().some((e) => e.event === "affinity_cleared")).toBe(false);
  });

  it("retains owner through a plaintext model lock, then resumes old ciphertext", async () => {
    const first = await getProviderCredentials("codex", null, "gpt-5.5", opts);
    const conns = await mocks.getProviderConnections();
    const owner = conns.find((c) => c.id === first.connectionId);
    owner["modelLock_gpt-5.5"] = new Date(Date.now() + 60_000).toISOString();
    expect(await getProviderCredentials("codex", null, "gpt-5.5", opts))
      .toMatchObject({ affinityUnavailable: true, retryable: true });
    delete owner["modelLock_gpt-5.5"];
    expect(await getProviderCredentials("codex", null, "gpt-5.5", { ...opts, encryptedContent: true }))
      .toMatchObject({ affinity: "hit", connectionId: first.connectionId });
    expect(events().some((e) => e.event === "affinity_cleared")).toBe(false);
  });

  it.each(["banned", "expired", "credits_exhausted", "cooldown", "inactive"])("does not replace %s owner", async (state) => {
    const first = await getProviderCredentials("codex", null, "gpt-5.5", opts);
    const conns = await mocks.getProviderConnections();
    const owner = conns.find((c) => c.id === first.connectionId);
    if (state === "cooldown") owner.rateLimitedUntil = new Date(Date.now() + 60_000).toISOString();
    else if (state === "inactive") mocks.getProviderConnections.mockResolvedValue(conns.filter((c) => c !== owner));
    else owner.testStatus = state;
    const snapshot = new Map(store);
    const result = await getProviderCredentials("codex", null, "gpt-5.5", { ...opts, encryptedContent: true });
    expect(result).toMatchObject({ affinityUnavailable: true, retryable: true });
    expect(store).toEqual(snapshot);
  });

  it("keeps an excluded owner instead of clearing its mapping", async () => {
    const first = await getProviderCredentials("codex", null, "gpt-5.5", opts);
    const snapshot = new Map(store);
    const result = await getProviderCredentials("codex", new Set([first.connectionId]), "gpt-5.5",
      { ...opts, encryptedContent: true });
    expect(result).toMatchObject({ affinityUnavailable: true, reason: "pinned account excluded", retryable: true });
    expect(store).toEqual(snapshot);
    expect(events().map((e) => e.event)).toEqual(["affinity_created", "affinity_unavailable"]);
  });

  it("requires a preexisting owner for ciphertext even with only one active account", async () => {
    mocks.getProviderConnections.mockResolvedValue([conn("conn-aaaa-1111")]);
    const result = await getProviderCredentials("codex", null, "gpt-5.5", { ...opts, encryptedContent: true });
    expect(result).toMatchObject({ affinityUnavailable: true });
    expect(store.size).toBe(0);
  });

  it("requires a session key for ciphertext", async () => {
    const result = await getProviderCredentials("codex", null, "gpt-5.5", { apiKey: "k", encryptedContent: true });
    expect(result).toMatchObject({ affinityUnavailable: true });
    expect(store.size).toBe(0);
  });

  it("TTL=0 disables leases, not ownership or ciphertext safety", async () => {
    mocks.getSettings.mockResolvedValue({ sessionAffinityTtlMs: 0 });
    expect(await getProviderCredentials("codex", null, "gpt-5.5", { ...opts, encryptedContent: true }))
      .toMatchObject({ affinityUnavailable: true });
    const first = await getProviderCredentials("codex", null, "gpt-5.5", opts);
    expect(first.affinity).toBe("created");
    expect(await getProviderCredentials("codex", null, "gpt-5.5", { ...opts, encryptedContent: true }))
      .toMatchObject({ affinity: "hit", connectionId: first.connectionId });
  });

  it.each([-1000, 60_000])("promotes legacy owner even if lease expiry offset is %s", async (offset) => {
    store.set(rowKey("sessionAccountAffinity", identity()), JSON.stringify({ connectionId: "conn-bbbb-2222", expiresAt: Date.now() + offset }));
    expect(await getProviderCredentials("codex", null, "gpt-5.5", { ...opts, encryptedContent: true }))
      .toMatchObject({ affinity: "hit", connectionId: "conn-bbbb-2222" });
    expect(await affinity.readOwner(identity())).toMatchObject({ version: 1, connectionId: "conn-bbbb-2222" });
  });

  it("creating a different session never sweeps another expired legacy owner", async () => {
    store.set(rowKey("sessionAccountAffinity", identity()), JSON.stringify({ connectionId: "conn-bbbb-2222", expiresAt: Date.now() - 1000 }));
    await getProviderCredentials("codex", null, "gpt-5.5", { ...opts, sessionKey: "other" });
    expect(await getProviderCredentials("codex", null, "gpt-5.5", { ...opts, encryptedContent: true }))
      .toMatchObject({ affinity: "hit", connectionId: "conn-bbbb-2222" });
  });

  it.each(["sessionAccountOwner", "sessionAccountAffinity"])("fails closed without overwriting corrupt %s", async (scope) => {
    store.set(rowKey(scope, identity()), "{broken");
    const snapshot = new Map(store);
    expect(await getProviderCredentials("codex", null, "gpt-5.5", opts))
      .toMatchObject({ affinityUnavailable: true, retryable: false });
    expect(store).toEqual(snapshot);
  });

  it("respects an immutable winner from another selector", async () => {
    await affinity.claimOwner(identity(), "conn-bbbb-2222");
    expect(await getProviderCredentials("codex", null, "gpt-5.5", opts))
      .toMatchObject({ affinity: "hit", connectionId: "conn-bbbb-2222" });
    const result = await affinity.claimOwner(identity(), "conn-aaaa-1111");
    expect(result.owner.connectionId).toBe("conn-bbbb-2222");
    expect(result.created).toBe(false);
  });
});

describe("ownership and lease helpers", () => {
  it("diagnostic reads do not mutate expired legacy evidence", async () => {
    const identity = affinity.affinityIdentity("s", "codex", "k");
    store.set(rowKey("sessionAccountAffinity", identity), JSON.stringify({ connectionId: "conn-old", expiresAt: 1 }));
    const snapshot = new Map(store);
    expect(await affinity.readOwner(identity)).toBeNull();
    expect(await affinity.readPin(identity)).toMatchObject({ connectionId: "conn-old", expired: true });
    expect(store).toEqual(snapshot);
  });

  it("clearing a lease cannot delete ownership or another connection's lease", async () => {
    const identity = affinity.affinityIdentity("s", "codex", "k");
    await affinity.claimOwner(identity, "conn-new");
    await affinity.setPin(identity, "conn-new", 60_000);
    expect(await affinity.clearPin(identity, "conn-old")).toBe(false);
    expect((await affinity.readPin(identity)).connectionId).toBe("conn-new");
    expect(await affinity.clearPin(identity, "conn-new")).toBe(true);
    expect((await affinity.readOwner(identity)).connectionId).toBe("conn-new");
  });
});

describe("response helpers", () => {
  it("adds truncated connection id and affinity status headers", () => {
    const res = affinity.withAffinityHeaders(new Response("ok", { status: 200 }),
      { connectionId: "conn-aaaa-1111", affinity: "hit" });
    expect(res.headers.get("x-9router-connection-id")).toBe("conn-aaa");
    expect(res.headers.get("x-9router-affinity")).toBe("hit");
  });

  it("returns a terminal 409 for unknown ownership", async () => {
    const res = affinity.affinityUnavailableResponse("missing original owner");
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("session_affinity_unavailable");
    expect(body.error.message).toContain("missing original owner");
  });

  it("temporary failure tells client to retain and retry same session", async () => {
    const body = await affinity.affinityUnavailableResponse("pinned account failed with upstream 429", true).json();
    expect(body.error.message).toMatch(/same session/i);
    expect(body.error.message).not.toMatch(/Start a new session/);
  });
});
