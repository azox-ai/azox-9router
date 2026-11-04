import { afterEach, describe, expect, it, vi } from "vitest";
import { handleComboChat, handleFusionChat } from "../../open-sse/services/combo.js";

const log = { info() {}, warn() {}, debug() {} };
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
  status, headers: { "content-type": "application/json", ...headers },
});
const answer = (content) => json({ choices: [{ message: { content } }] });
const run = (handleSingleModel, extra = {}) => handleComboChat({
  body: { messages: [{ role: "user", content: "fixture" }] },
  models: ["fixture/a", "fixture/b"], comboStrategy: "fallback", handleSingleModel, log, ...extra,
});
afterEach(() => vi.useRealTimers());

describe("combo bounded diagnostics", () => {
  it("cancels an oversized error body before trying the next model", async () => {
    let cancelled = false;
    const error = new Response(new ReadableStream({
      start(c) { c.enqueue(new Uint8Array(256 * 1024 + 1)); },
      cancel() { cancelled = true; },
    }), { status: 429 });
    let calls = 0;
    const result = await run(async () => ++calls === 1 ? error : answer("served"));
    expect(cancelled).toBe(true);
    expect(result.status).toBe(200);
    expect(calls).toBe(2);
  });

  it("bounds a stalled diagnostic read and cancels its source", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const error = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 429 });
    let calls = 0;
    const pending = run(async () => ++calls === 1 ? error : answer("served"));
    await vi.advanceTimersByTimeAsync(5100);
    expect(cancelled).toBe(true);
    expect((await pending).status).toBe(200);
  });

  it("returns 499 and cancels a diagnostic body on client abort", async () => {
    const client = new AbortController();
    let cancelled = false;
    const error = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 429 });
    const pending = run(async () => error, { signal: client.signal });
    await new Promise((resolve) => setTimeout(resolve, 10));
    client.abort();
    const result = await pending;
    expect(result.status).toBe(499);
    expect(cancelled).toBe(true);
  });

  it("keeps status and message from the same retryable attempt", async () => {
    let calls = 0;
    const result = await run(async () => ++calls === 1
      ? json({ error: { message: "first rate limit" } }, 429)
      : json({ error: { message: "second internal failure" } }, 500));
    expect(result.status).toBe(500);
    expect((await result.json()).error.message).toContain("second internal failure");
  });

  it("uses an HTTP Retry-After delay without interpreting it as a date", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-09T12:00:00Z"));
    const result = await run(async () => json({ error: { message: "rate limit" } }, 429, { "retry-after": "30" }));
    expect(result.headers.get("retry-after")).toBe("30");
  });

  it("does not apply the diagnostic byte limit to successful JSON", async () => {
    const content = "x".repeat(512 * 1024);
    const result = await run(async () => answer(content));
    expect((await result.json()).choices[0].message.content).toBe(content);
  });
});

describe("fusion successful-body contract", () => {
  it("accepts panel answers larger than the diagnostic body limit", async () => {
    const content = "x".repeat(512 * 1024);
    let judgeText;
    const result = await handleFusionChat({
      body: { messages: [{ role: "user", content: "fixture" }] },
      models: ["fixture/a", "fixture/b"], judgeModel: "fixture/judge", log,
      handleSingleModel: async (body, _model, panel) => {
        if (panel) return answer(content);
        judgeText = body.messages.at(-1).content;
        return answer("judged");
      },
    });
    expect(result.status).toBe(200);
    expect(judgeText.split(content)).toHaveLength(3);
  });
});
