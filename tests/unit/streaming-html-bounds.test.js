import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Persistence stays off disk; streaming handler and Combo execute normally.
vi.mock("@/lib/usageDb.js", () => ({
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
  appendRequestLog: vi.fn(async () => {}),
  trackPendingRequest: vi.fn(),
}));

import { handleStreamingResponse } from "../../open-sse/handlers/chatCore/streamingHandler.js";
import { handleComboChat } from "../../open-sse/services/combo.js";

const CAP = 16 * 1024;
const DEADLINE = 5000;
const encode = text => new TextEncoder().encode(text);
const log = Object.fromEntries(["line", "errorLine", "info", "warn", "error", "debug"].map(key => [key, vi.fn()]));
const args = (providerResponse, signal) => ({
  providerResponse, provider: "openai", model: "bounded-html", log,
  body: { model: "openai/bounded-html", stream: true, messages: [{ role: "user", content: "hi" }] },
  streamController: { signal, handleError: vi.fn() },
  onRequestSuccess: vi.fn(),
});

// Every fixture ends within 15s of virtual time, even with the old unbounded reader.
function stalled({ trickle = false, cancellation = "resolve" } = {}) {
  let controller;
  let closed = false;
  const cancel = vi.fn(() => {
    closed = true;
    clearTimeout(stop);
    if (cancellation === "reject") return Promise.reject(new Error("synthetic cancel rejection"));
    if (cancellation === "delay") return new Promise(resolve => setTimeout(resolve, 10000));
  });
  const stream = new ReadableStream({
    start(value) { controller = value; },
    cancel,
  }, { highWaterMark: 0 });
  const stop = setTimeout(() => {
    if (!closed) { closed = true; controller.close(); }
  }, 10000);
  if (trickle) {
    for (const ms of [1000, 2000, 3000, 4000, 6000, 8000]) {
      setTimeout(() => { if (!closed) controller.enqueue(encode("x")); }, ms);
    }
  }
  return { response: new Response(stream, { headers: { "content-type": "text/html" } }), cancel };
}

async function completeError(result, status = 502) {
  expect(result).toMatchObject({ success: false, status });
  expect(result.response.status).toBe(status);
  expect(result.response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  expect(await result.response.json()).toMatchObject({ error: { message: result.error } });
}

beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  await vi.runAllTimersAsync();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("bounded non-SSE error reads", () => {
  it("caps bytes inside a single oversized chunk and cancels without draining", async () => {
    let pulls = 0;
    const cancel = vi.fn();
    const stream = new ReadableStream({
      pull(controller) {
        pulls++;
        if (pulls === 1) controller.enqueue(encode("é".repeat(CAP / 2) + "<title>outside byte cap</title>"));
        else controller.close();
      }, cancel,
    }, { highWaterMark: 0 });
    const response = new Response(stream, { headers: { "content-type": "text/html" } });
    const input = args(response);
    const result = await handleStreamingResponse(input);
    await completeError(result);
    expect(result.error).not.toContain("outside byte cap");
    expect(pulls).toBe(1);
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body.locked).toBe(false);
    expect(input.onRequestSuccess).not.toHaveBeenCalled();
    expect(input.streamController.handleError).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops at an exact multi-chunk byte cap without an extra read", async () => {
    let pulls = 0;
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({
      pull(controller) {
        if (++pulls <= 4) controller.enqueue(encode("x".repeat(CAP / 2)));
        else controller.close();
      }, cancel,
    }, { highWaterMark: 0 }), { headers: { "content-type": "text/plain" } });
    await completeError(await handleStreamingResponse(args(response)));
    expect(pulls).toBe(2);
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body.locked).toBe(false);
  });

  it.each([false, true])("enforces one total deadline with trickle=%s", async trickle => {
    const { response, cancel } = stalled({ trickle });
    let result;
    const pending = handleStreamingResponse(args(response)).then(value => { result = value; });
    await vi.advanceTimersByTimeAsync(DEADLINE);
    const returnedByDeadline = Boolean(result);
    await vi.advanceTimersByTimeAsync(10000);
    await pending;
    expect(returnedByDeadline).toBe(true);
    await completeError(result);
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body.locked).toBe(false);
  });

  it.each(["delay", "reject"])("does not await %s cancellation or leak its rejection", async cancellation => {
    const { response, cancel } = stalled({ cancellation });
    let result;
    const pending = handleStreamingResponse(args(response)).then(value => { result = value; });
    await vi.advanceTimersByTimeAsync(DEADLINE);
    const returnedByDeadline = Boolean(result);
    const unlockedByDeadline = !response.body.locked;
    await vi.advanceTimersByTimeAsync(15000);
    await pending;
    expect(returnedByDeadline).toBe(true);
    expect(unlockedByDeadline).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    await completeError(result);
  });

  it.each([false, true])("cleans up caller abort, alreadyAborted=%s", async alreadyAborted => {
    const { response, cancel } = stalled();
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    if (alreadyAborted) controller.abort();
    let result;
    const pending = handleStreamingResponse(args(response, controller.signal)).then(value => { result = value; });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    const returnedOnAbort = Boolean(result);
    await vi.advanceTimersByTimeAsync(10000);
    await pending;
    expect(returnedOnAbort).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body.locked).toBe(false);
    for (const [event, listener] of add.mock.calls) {
      if (event === "abort") expect(remove).toHaveBeenCalledWith("abort", listener);
    }
    await completeError(result);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps an upstream error complete when another caller already locked its body", async () => {
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(encode("ignored")); controller.close(); },
    }), { status: 503, headers: { "content-type": "text/html" } });
    const otherReader = response.body.getReader();
    try {
      await completeError(await handleStreamingResponse(args(response)), 503);
      expect(response.body.locked).toBe(true);
    } finally {
      otherReader.releaseLock();
    }
  });

  it("limits empty-chunk spins and cancels a finite empty stream", async () => {
    let pulls = 0;
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({
      pull(controller) {
        if (++pulls <= 512) controller.enqueue(new Uint8Array(0));
        else controller.close();
      }, cancel,
    }, { highWaterMark: 0 }), { headers: { "content-type": "text/plain" } });
    await completeError(await handleStreamingResponse(args(response)));
    expect(pulls).toBeLessThanOrEqual(32);
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("handles reader rejection and releases its lock and watchdog", async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const response = new Response(new ReadableStream({
      pull(stream) { stream.error(new Error("synthetic read rejection")); },
    }), { status: 503, headers: { "content-type": "text/html" } });
    const input = args(response, controller.signal);
    await completeError(await handleStreamingResponse(input), 503);
    expect(response.body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    for (const [event, listener] of add.mock.calls) {
      if (event === "abort") expect(remove).toHaveBeenCalledWith("abort", listener);
    }
    expect(input.onRequestSuccess).not.toHaveBeenCalled();
  });

  it("preserves a complete title across UTF-8 chunks and cleans up normal EOF", async () => {
    const bytes = encode("<title>Lỗi tạm thời</title>");
    const response = new Response(new ReadableStream({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    }), { headers: { "content-type": "text/html" } });
    const result = await handleStreamingResponse(args(response));
    await completeError(result);
    expect(result.error).toContain("Lỗi tạm thời");
    expect(response.body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lets real Combo fallback continue after the stalled member deadline", async () => {
    const { response, cancel } = stalled();
    const tried = [];
    let result;
    const pending = handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }], stream: false },
      models: ["openai/bounded-html", "openai/valid"],
      comboName: "bounded-html-fallback", comboStrategy: "fallback", log,
      handleSingleModel: async (_body, model) => {
        tried.push(model);
        if (model === "openai/bounded-html") return (await handleStreamingResponse(args(response))).response;
        return Response.json({ choices: [{ message: { role: "assistant", content: "fallback answer" }, finish_reason: "stop" }] });
      },
    }).then(value => { result = value; });
    await vi.advanceTimersByTimeAsync(DEADLINE + 1000);
    const returnedByDeadline = Boolean(result);
    await vi.advanceTimersByTimeAsync(10000);
    await pending;
    expect(returnedByDeadline).toBe(true);
    expect(tried).toEqual(["openai/bounded-html", "openai/valid"]);
    expect(result.status).toBe(200);
    expect(cancel).toHaveBeenCalledOnce();
    expect(await result.json()).toMatchObject({ choices: [{ message: { content: "fallback answer" } }] });
  });
});
