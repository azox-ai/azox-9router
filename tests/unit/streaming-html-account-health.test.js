import { describe, expect, it, vi } from "vitest";
import { handleStreamingResponse } from "../../open-sse/handlers/chatCore/streamingHandler.js";

describe("streaming upstream response validation", () => {
  it("does not report account success when upstream returns HTML instead of SSE", async () => {
    const success = vi.fn();
    const result = await handleStreamingResponse({
      providerResponse: new Response("<html><title>Bad gateway</title></html>", {
        status: 200, headers: { "content-type": "text/html" },
      }),
      provider: "claude", model: "test-model", onRequestSuccess: success,
      streamController: { handleError: vi.fn() },
      log: { errorLine: vi.fn() },
    });
    await Promise.resolve();
    expect(result.success).toBe(false);
    expect(success).not.toHaveBeenCalled();
  });
});
