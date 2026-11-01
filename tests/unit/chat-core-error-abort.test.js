import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getEventListeners } from "node:events";
import "../translator/registerAll.js";

const seams = vi.hoisted(() => ({
  execute: vi.fn(),
  parseError: vi.fn(),
  pending: vi.fn(),
  appendLog: vi.fn(async () => {}),
  saveDetail: vi.fn(async () => {}),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ noAuth: true, execute: seams.execute, parseError: seams.parseError }),
}));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest() {}, logRawRequest() {}, logTargetRequest() {},
    logProviderResponse() {}, logConvertedResponse() {}, logError() {},
  }),
}));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: seams.pending,
  appendRequestLog: seams.appendLog,
  saveRequestDetail: seams.saveDetail,
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({ requireApiKey: false }),
  getModelAliases: async () => ({}), getComboByName: async () => null,
  getCombos: async () => [], getProviderNodes: async () => [],
  getProviderConnections: async () => [], getProviderConnectionById: async () => null,
  getCustomModels: async () => [],
}));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: async () => ({}) }));
vi.mock("@/lib/db/repos/combosRepo.js", () => ({ getCombos: async () => [] }));
vi.mock("@/lib/db/repos/apiKeysRepo.js", () => ({ getApiKeyByKey: async () => null }));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: async () => ({ connectionId: "abort-fixture", providerSpecificData: {} }),
  markAccountUnavailable: async () => ({ shouldFallback: false }),
  clearAccountError: async () => {}, extractApiKey: () => null, isValidApiKey: async () => true,
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_provider, credentials) => credentials,
  updateProviderCredentials: async () => {},
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { handleChat } = await import("../../src/sse/handlers/chat.js");

// Removing signal propagation at the real caller must leave this finite read
// pending until the guard fires, rather than returning the required HTTP 499.
function finiteErrorBody({ reject = false } = {}) {
  let finish;
  const state = { reads: 0, cancelled: 0, released: 0, guardFired: false };
  const body = new ReadableStream({
    start(controller) {
      finish = () => {
        try {
          if (reject) controller.error(new Error("synthetic transport failure"));
          else controller.close();
        } catch { /* already cancelled */ }
      };
    },
    pull() { state.reads++; },
    cancel() { state.cancelled++; },
  }, { highWaterMark: 0 });
  const guard = setTimeout(() => { state.guardFired = true; finish(); }, 2000);
  return { state, body, dispose() { clearTimeout(guard); finish(); } };
}

function invoke(response, signal) {
  const success = vi.fn();
  seams.execute.mockResolvedValue({ response, url: "https://upstream.invalid/chat", headers: {}, transformedBody: null });
  return {
    success,
    result: handleChatCore({
      body: { model: "gpt-4o", stream: false, messages: [{ role: "user", content: "fixture" }] },
      modelInfo: { provider: "openai", model: "gpt-4o" },
      credentials: { providerSpecificData: {} },
      signal, onRequestSuccess: success, connectionId: "abort-fixture",
      log: { debug() {}, info() {}, warn() {}, line() {}, errorLine() {} },
      rtkEnabled: false, headroomEnabled: false, cavemanEnabled: false, ponytailEnabled: false,
    }),
  };
}

function upstream(body) {
  return { ok: false, status: 503, body, headers: new Headers({ "retry-after": "7" }) };
}

async function settle(call, milliseconds = 100) {
  let value;
  let failure;
  call.result.then(result => { value = result; }, error => { failure = error; });
  await vi.advanceTimersByTimeAsync(milliseconds);
  if (failure) throw failure;
  return value;
}

function assertAccounting(call, status) {
  expect(call.success).not.toHaveBeenCalled();
  expect(seams.pending.mock.calls.map(args => args[3])).toEqual([true, false]);
  expect(seams.appendLog.mock.calls.at(-1)[0].status).toBe(`FAILED ${status}`);
  expect(seams.saveDetail.mock.calls.at(-1)[0].response.status).toBe(status);
}

describe("real handleChatCore upstream error cancellation", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("cancels an already-aborted error body without starting its reader", async () => {
    const controller = new AbortController();
    controller.abort();
    const fixture = finiteErrorBody();
    const call = invoke(upstream(fixture.body), controller.signal);
    try {
      const result = await settle(call);
      expect(result?.status).toBe(499);
      expect(result.response.status).toBe(499);
      expect(result.success).toBe(false);
      expect(fixture.state.reads).toBe(0);
      expect(fixture.state.cancelled).toBe(1);
      expect(seams.parseError).not.toHaveBeenCalled();
      assertAccounting(call, 499);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    } finally {
      fixture.dispose();
      await vi.advanceTimersByTimeAsync(2100);
      await call.result;
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([undefined, new Error("synthetic deadline")])("aborts while real parser reader is pending (%s)", async reason => {
    const fixture = finiteErrorBody();
    const controller = new AbortController();
    const call = invoke(upstream(fixture.body), controller.signal);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.state.reads).toBe(1);
      controller.abort(reason);
      const result = await settle(call);
      expect(result?.status).toBe(499);
      expect(result.response.status).toBe(499);
      expect(result.success).toBe(false);
      expect(fixture.state.cancelled).toBe(1);
      expect(fixture.body.locked).toBe(false);
      expect(fixture.state.guardFired).toBe(false);
      expect(seams.parseError).not.toHaveBeenCalled();
      assertAccounting(call, 499);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    } finally {
      fixture.dispose();
      await vi.advanceTimersByTimeAsync(2100);
      await call.result;
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves complete provider errors, headers and reset expiry without cancellation", async () => {
    const controller = new AbortController();
    const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"error":{"message":"busy"}}')); c.close(); } });
    seams.parseError.mockReturnValueOnce({ status: 429, message: "busy", resetsAtMs: 1234567890000 });
    const call = invoke(upstream(body), controller.signal);
    const result = await call.result;
    expect(result.status).toBe(429);
    expect(result.response.status).toBe(429);
    expect(result.response.headers.get("retry-after")).toBe("7");
    expect(result.resetsAtMs).toBe(1234567890000);
    expect(body.locked).toBe(false);
    assertAccounting(call, 429);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(2100);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("propagates HTTP request cancellation through the app caller and real core parser", async () => {
    const fixture = finiteErrorBody();
    const controller = new AbortController();
    seams.execute.mockResolvedValue({ response: upstream(fixture.body), url: "https://upstream.invalid/chat", headers: {} });
    const request = new Request("http://localhost/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal,
      body: JSON.stringify({ model: "openai/gpt-4o", stream: false, messages: [{ role: "user", content: "fixture" }] }),
    });
    const call = { result: handleChat(request) };
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.state.reads).toBe(1);
      controller.abort();
      const response = await settle(call);
      expect(response?.status).toBe(499);
      expect(fixture.state.cancelled).toBe(1);
      expect(fixture.body.locked).toBe(false);
      expect(fixture.state.guardFired).toBe(false);
      expect(seams.parseError).not.toHaveBeenCalled();
      expect(getEventListeners(request.signal, "abort")).toHaveLength(0);
    } finally {
      fixture.dispose();
      await vi.advanceTimersByTimeAsync(2100);
      await call.result;
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps transport-read rejection structured and releases the reader", async () => {
    const fixture = finiteErrorBody({ reject: true });
    const call = invoke(upstream(fixture.body), new AbortController().signal);
    try {
      const result = await settle(call, 2100);
      expect(result.status).toBe(503);
      expect(result.response.headers.get("retry-after")).toBe("7");
      // An errored ReadableStream is already terminal; cancel() need not invoke its source.
      expect(fixture.state.cancelled).toBe(0);
      expect(fixture.body.locked).toBe(false);
      assertAccounting(call, 503);
    } finally { fixture.dispose(); }
    expect(vi.getTimerCount()).toBe(0);
  });
});
