import { describe, expect, it, vi } from "vitest";

// Keep request-detail persistence off disk; handlers and Combo stay real.
vi.mock("@/lib/usageDb.js", () => ({
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
  appendRequestLog: vi.fn(async () => {}),
  trackPendingRequest: vi.fn(),
}));

import { handleStreamingResponse } from "../../open-sse/handlers/chatCore/streamingHandler.js";
import { handleComboChat } from "../../open-sse/services/combo.js";

const log = Object.fromEntries(["line", "errorLine", "info", "warn", "error", "debug"].map(key => [key, vi.fn()]));
const htmlResponse = (status = 200) => new Response("<html><title>Bad gateway</title></html>", {
  status, headers: { "content-type": "text/html" },
});
const streamingArgs = providerResponse => ({
  providerResponse, provider: "openai", model: "html-seat", log,
  body: { model: "openai/html-seat", stream: true, messages: [{ role: "user", content: "hi" }] },
  streamController: { handleError: vi.fn() },
});

describe("invalid streaming upstream content", () => {
  it("returns a complete gateway error instead of HTTP 200 for HTML", async () => {
    const onRequestSuccess = vi.fn();
    const result = await handleStreamingResponse({ ...streamingArgs(htmlResponse()), onRequestSuccess });
    await Promise.resolve();
    expect.soft(result.success).toBe(false);
    expect.soft(result.status).toBe(502);
    expect.soft(result.response.status).toBe(502);
    expect.soft(result.response.ok).toBe(false);
    expect.soft(result.error).toEqual(expect.stringContaining("Bad gateway"));
    const body = await result.response.json();
    expect.soft(body.error.message).toEqual(expect.stringContaining("Bad gateway"));
    expect(onRequestSuccess).not.toHaveBeenCalled();
  });

  it("preserves an upstream non-2xx status in the complete error result", async () => {
    const result = await handleStreamingResponse(streamingArgs(htmlResponse(503)));
    expect.soft(result.status).toBe(503);
    expect.soft(result.response.status).toBe(503);
    expect(result.error).toEqual(expect.stringContaining("Bad gateway"));
  });

  it("tries the next Combo member after the streaming handler rejects HTML 200", async () => {
    const tried = [];
    const response = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }], stream: false },
      models: ["openai/html-seat", "openai/valid-seat"],
      comboName: "html-fallback-regression", comboStrategy: "fallback", log,
      handleSingleModel: async (_body, model) => {
        tried.push(model);
        if (model === "openai/html-seat") {
          return (await handleStreamingResponse(streamingArgs(htmlResponse()))).response;
        }
        return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "second member answer" }, finish_reason: "stop" }] }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      },
    });
    expect.soft(tried).toEqual(["openai/html-seat", "openai/valid-seat"]);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ choices: [{ message: { content: "second member answer" } }] });
  });
});
