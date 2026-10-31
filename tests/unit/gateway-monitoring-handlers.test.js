import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fx = vi.hoisted(() => ({ combos: [], settings: {}, fallback: false }));
const mocks = vi.hoisted(() => ({ core: vi.fn(), credentials: vi.fn() }));
vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({ requireApiKey: false, comboStrategy: "fallback", ...fx.settings }),
  getModelAliases: async () => ({}),
  getComboByName: async name => fx.combos.find(c => c.name === name) || null,
  getCombos: async () => fx.combos,
  getProviderNodes: async () => [], getProviderConnections: async () => [],
  getProviderConnectionById: async () => null, getCustomModels: async () => [],
}));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: async () => ({}) }));
vi.mock("@/lib/db/repos/combosRepo.js", () => ({ getCombos: async () => fx.combos }));
vi.mock("@/lib/db/repos/apiKeysRepo.js", () => ({ getApiKeyByKey: async () => null }));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: vi.fn() }));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.credentials,
  markAccountUnavailable: async () => ({ shouldFallback: fx.fallback }),
  clearAccountError: vi.fn(),
  extractApiKey: request => request.headers.get("Authorization")?.slice(7),
  isValidApiKey: async () => true,
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_provider, credentials) => credentials,
  updateProviderCredentials: vi.fn(),
}));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: mocks.core }));
const { handleChat } = await import("../../src/sse/handlers/chat.js");

let output;
const success = () => ({ success: true, response: Response.json({ choices: [{ message: { content: "answer" } }] }) });
const failure = () => ({ success: false, status: 429, error: "dummy-upstream-error", response: Response.json({ error: "rate limited" }, { status: 429 }) });
const chat = model => handleChat(new Request("http://localhost/v1/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: "Bearer dummy-key-secret",
    "x-correlation-id": "trace-123", "x-llm-key-alias": "key-alias", "x-llm-team-alias": "team-alias" },
  body: JSON.stringify({ model, stream: false, messages: [{ role: "user", content: "dummy-private-body" }] }),
}));
const events = () => output.mock.calls.flatMap(([line]) => {
  try { const event = JSON.parse(line); return event.event === "llm_gateway.router_attempt" ? [event] : []; }
  catch { return []; }
});
const combo = (name, models) => ({ id: name, name, models });

beforeEach(() => {
  vi.clearAllMocks();
  fx.combos = [combo("Main", ["openai/model-a", "openai/model-b"])];
  fx.settings = {}; fx.fallback = false;
  mocks.credentials.mockResolvedValue({ connectionId: "conn", connectionName: "account-alias", accessToken: "dummy-token-secret" });
  mocks.core.mockImplementation(async () => success());
  output = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("gateway attempt telemetry through real chat and combo handlers", () => {
  it("emits one bounded metadata-only event for a direct request", async () => {
    expect((await chat("openai/model-b")).status).toBe(200);
    expect(events()).toEqual([expect.objectContaining({
      event: "llm_gateway.router_attempt", router: "ninerouter", correlation_id: "trace-123",
      key_alias: "key-alias", team_alias: "team-alias", combo: null, attempt: 1,
      account_attempt: 1, provider: "openai", model: "model-b", account: "account-alias",
      status: 200, outcome: "success", latency_ms: expect.any(Number),
    })]);
    expect(Object.keys(events()[0]).sort()).toEqual(["event", "router", "correlation_id", "key_alias", "team_alias", "combo", "attempt", "account_attempt", "provider", "model", "account", "status", "outcome", "latency_ms"].sort());
    expect(JSON.stringify(events())).not.toMatch(/dummy-key-secret|dummy-token-secret|dummy-private-body|Authorization/);
  });

  it("records each failed and successful model attempt in fallback order", async () => {
    mocks.core.mockImplementation(async ({ modelInfo }) => modelInfo.model === "model-a" ? failure() : success());
    expect((await chat("Main")).status).toBe(200);
    expect(events().map(e => [e.combo, e.attempt, e.model, e.status, e.outcome])).toEqual([
      ["Main", 1, "model-a", 429, "failure"], ["Main", 2, "model-b", 200, "success"],
    ]);
  });

  it("counts account fallback independently from the combo attempt", async () => {
    fx.fallback = true;
    mocks.credentials.mockImplementation(async (_provider, excluded) => ({ connectionId: excluded.size ? "conn2" : "conn1" }));
    mocks.core.mockResolvedValueOnce(failure()).mockImplementation(async () => success());
    expect((await chat("openai/model-b")).status).toBe(200);
    expect(events().map(e => [e.account, e.account_attempt, e.attempt, e.status])).toEqual([
      ["conn1", 1, 1, 429], ["conn2", 2, 1, 200],
    ]);
  });

  it("records thrown core failures once without logging the error payload", async () => {
    mocks.core.mockRejectedValueOnce(new Error("dummy-private-error"));
    await expect(chat("openai/model-b")).rejects.toThrow("dummy-private-error");
    expect(events()).toEqual([expect.objectContaining({ status: 500, outcome: "failure", account_attempt: 1 })]);
    expect(JSON.stringify(events())).not.toContain("dummy-private-error");
  });

  it("carries aliases into nested combos and uses the innermost combo attempt", async () => {
    fx.combos.push(combo("Outer", ["Main"]));
    mocks.core.mockImplementation(async ({ modelInfo }) => modelInfo.model === "model-a" ? failure() : success());
    expect((await chat("Outer")).status).toBe(200);
    expect(events().map(e => [e.correlation_id, e.combo, e.attempt])).toEqual([
      ["trace-123", "Main", 1], ["trace-123", "Main", 2],
    ]);
  });

  it.each([["Main"], ["Outer"]])("records fusion panel and judge attempts for %s", async target => {
    fx.combos.push(combo("Outer", ["Main"]));
    fx.settings = { comboStrategies: { Main: { fallbackStrategy: "fusion" } } };
    expect((await chat(target)).status).toBe(200);
    expect(events().map(e => [e.combo, e.attempt, e.model])).toEqual([
      ["Main", 1, "model-a"], ["Main", 2, "model-b"], ["Main", 3, "model-a"],
    ]);
    expect(events().every(e => e.correlation_id === "trace-123" && e.key_alias === "key-alias")).toBe(true);
  });
});
