import { describe, expect, it, vi } from "vitest";
import { parseUpstreamError } from "../../open-sse/utils/error.js";

const fallback = { statusCode: 429, message: "Rate limit exceeded" };

describe("bounded upstream error parsing", () => {
  it("rejects an oversized declared body before reading and cancels it", async () => {
    // A finite body lets the unbounded baseline finish instead of hanging.
    const response = new Response("private diagnostic", {
      status: 429, headers: { "content-length": "262145" },
    });
    const cancel = vi.spyOn(response.body, "cancel");
    expect(await parseUpstreamError(response)).toEqual(fallback);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("limits streamed bytes even without content-length", async () => {
    const cancel = vi.fn();
    let source;
    const response = new Response(new ReadableStream({
      start(controller) {
        source = controller;
        controller.enqueue(new Uint8Array(262145).fill(120));
      },
      cancel,
    }), { status: 429 });
    const timer = setTimeout(() => { try { source.close(); } catch { /* already cancelled */ } }, 100);
    try {
      expect(await parseUpstreamError(response)).toEqual(fallback);
      expect(cancel).toHaveBeenCalledOnce();
      expect(response.body.locked).toBe(false);
    } finally { clearTimeout(timer); }
  });

  it("falls back on truncated identity framing", async () => {
    expect(await parseUpstreamError(new Response("short", {
      status: 429, headers: { "content-length": "100" },
    }))).toEqual(fallback);
  });

  it("keeps decompressed error payloads despite compressed content-length", async () => {
    const response = new Response(JSON.stringify({ error: { message: "provider detail" } }), {
      status: 429, headers: { "content-length": "2", "content-encoding": "gzip" },
    });
    expect(await parseUpstreamError(response)).toEqual({ statusCode: 429, message: "provider detail" });
  });

  it("preserves provider-specific reset information", async () => {
    const executor = { parseError: (_response, text) => ({ status: 429, message: text, resetsAtMs: 123 }) };
    expect(await parseUpstreamError(new Response("detail", { status: 429 }), executor))
      .toEqual({ statusCode: 429, message: "detail", resetsAtMs: 123 });
  });

  it("propagates caller abort instead of returning a provider error", async () => {
    const controller = new AbortController();
    const reason = new DOMException("fixture aborted", "AbortError");
    controller.abort(reason);
    const response = new Response("detail", { status: 429 });
    await expect(parseUpstreamError(response, null, { signal: controller.signal })).rejects.toBe(reason);
  });

  it("stops a stalled body without changing provider status", async () => {
    const cancel = vi.fn();
    let source;
    const response = new Response(new ReadableStream({ start(controller) { source = controller; }, cancel }), { status: 429 });
    // Close the body at a finite deadline so an unbounded reader returns; only the bounded reader cancels first.
    const timer = setTimeout(() => { try { source.close(); } catch { /* already cancelled */ } }, 100);
    try {
      expect(await parseUpstreamError(response, null, { stallTimeoutMs: 5 })).toEqual(fallback);
      expect(cancel).toHaveBeenCalledOnce();
    } finally { clearTimeout(timer); }
  });
});
