import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  credentials: null,
  pending: [],
  begin: vi.fn(),
  success: vi.fn(),
  end: vi.fn(),
  clear: vi.fn(),
  unavailable: vi.fn(),
}));

vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: vi.fn(async () => state.credentials),
  beginAccountMutationAttempt: state.begin,
  recordAccountMutationSuccess: state.success,
  endAccountMutationAttempt: state.end,
  clearAccountError: state.clear,
  markAccountUnavailable: state.unavailable,
  extractApiKey: vi.fn(() => null),
  isValidApiKey: vi.fn(),
}));
vi.mock("@/lib/localDb", () => ({ getSettings: vi.fn(async () => ({})) }));
vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: vi.fn(async () => ({ provider: "claude", model: "test-model" })),
  getComboModels: vi.fn(async () => null),
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: vi.fn(async (_provider, credentials) => credentials),
  updateProviderCredentials: vi.fn(),
}));
vi.mock("open-sse/handlers/chatCore.js", () => ({
  handleChatCore: vi.fn((options) => new Promise((resolve) => state.pending.push({ options, resolve }))),
}));
vi.mock("@/lib/headroom/detect", () => ({ DEFAULT_HEADROOM_URL: "" }));
vi.mock("@/lib/pxpipe/loader.js", () => ({ getTransform: vi.fn() }));
vi.mock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: vi.fn() }));
vi.mock("open-sse/services/projectId.js", () => ({ getProjectIdForConnection: vi.fn() }));
vi.mock("@/sse/utils/logger.js", () => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), request: vi.fn(),
}));

const { handleChat } = await import("../../src/sse/handlers/chat.js");

const request = () => new Request("http://localhost/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "claude/test-model", messages: [{ role: "user", content: "hello" }] }),
});

async function waitForAttempt() {
  for (let tries = 0; tries < 100 && state.pending.length === 0; tries++) await new Promise((resolve) => setTimeout(resolve, 0));
  expect(state.pending.length).toBeGreaterThan(0);
  return state.pending.shift();
}

describe("chat account mutation ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.pending = [];
    state.credentials = { connectionId: "account-1", connectionName: "Test", accessToken: "dummy" };
    let id = 0;
    state.begin.mockImplementation(() => ({ id: ++id }));
    state.unavailable.mockResolvedValue({ shouldFallback: false, cooldownMs: 0 });
  });

  it("passes attempt ownership to success and late failure writers", async () => {
    const olderPromise = handleChat(request());
    const older = await waitForAttempt();
    const newerPromise = handleChat(request());
    const newer = await waitForAttempt();

    newer.options.onRequestSuccess();
    newer.resolve({ success: true, response: Response.json({ ok: true }) });
    await newerPromise;
    older.resolve({ success: false, status: 429, error: "quota", response: Response.json({ error: "quota" }, { status: 429 }) });
    await olderPromise;

    expect(state.begin).toHaveBeenCalledTimes(2);
    const first = state.begin.mock.results[0].value;
    const second = state.begin.mock.results[1].value;
    expect(state.success).toHaveBeenCalledWith(second);
    expect(state.clear).toHaveBeenCalledWith("account-1", state.credentials, "test-model", { mutationAttempt: second });
    expect(state.unavailable).toHaveBeenCalledWith("account-1", 429, "quota", "claude", "test-model", undefined, { mutationAttempt: first });
    expect(state.end).toHaveBeenCalledWith(first);
    expect(state.end).toHaveBeenCalledWith(second);
  });

  it("releases an attempt when chatCore succeeds without its success callback", async () => {
    const promise = handleChat(request());
    const attempt = await waitForAttempt();
    attempt.resolve({ success: true, bypass: true, response: Response.json({ bypass: true }) });
    await promise;

    const owner = state.begin.mock.results[0].value;
    expect(state.end).toHaveBeenCalledWith(owner);
  });

  it("does not release an attempt twice when success callback precedes a failed result", async () => {
    const promise = handleChat(request());
    const attempt = await waitForAttempt();
    await attempt.options.onRequestSuccess();
    attempt.resolve({ success: false, status: 502, error: "bad stream", response: Response.json({ error: "bad stream" }, { status: 502 }) });
    await promise;

    const owner = state.begin.mock.results[0].value;
    expect(state.end.mock.calls.filter(([value]) => value === owner)).toHaveLength(1);
  });
});
