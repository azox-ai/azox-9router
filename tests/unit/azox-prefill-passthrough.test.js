import { beforeEach, describe, expect, it, vi } from "vitest";

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ noAuth: true, execute }),
}));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(), logRawRequest: vi.fn(), logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(), logConvertedResponse: vi.fn(), logError: vi.fn(),
  }),
}));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async () => {}), saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

import { handleChatCore } from "../../open-sse/handlers/chatCore.js";

beforeEach(() => {
  vi.clearAllMocks();
  execute.mockResolvedValue({
    response: new Response(JSON.stringify({ id: "fixture", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }), {
      headers: { "content-type": "application/json" },
    }),
    url: "https://api.anthropic.com/v1/messages", headers: {}, transformedBody: null,
  });
});

describe("AZOX native Claude chat boundary", () => {
  it.each([[undefined, "user"], ["preserve", "assistant"]])("forwards explicit opt-in %s from client headers", async (prefill, role) => {
    const body = { model: "claude-sonnet-4-5", stream: false, messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "draft" }] },
    ] };
    const credentials = { accessToken: "fixture-token", providerSpecificData: {} };
    await handleChatCore({
      body, credentials, modelInfo: { provider: "claude", model: body.model },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() }, connectionId: "fixture",
      rtkEnabled: false, headroomEnabled: false, cavemanEnabled: false, ponytailEnabled: false, pxpipeEnabled: false,
      sourceFormatOverride: "claude",
      clientRawRequest: { endpoint: "/v1/messages", body, headers: {
        "user-agent": "claude-cli/2.1.280 (external, sdk-cli)",
        ...(prefill ? { "x-9router-assistant-prefill": prefill } : {}),
      } },
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0].body.messages.at(-1).role).toBe(role);
    expect(credentials.accessToken).toBe("fixture-token");
    expect(credentials.refreshToken).toBeUndefined();
  });
});
