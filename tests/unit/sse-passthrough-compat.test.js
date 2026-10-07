import { describe, it, expect, vi } from "vitest";
vi.mock("@/lib/usageDb.js", () => ({ trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async () => {}), saveRequestDetail: vi.fn(async () => {}), saveUsageHistory: vi.fn(async () => {}), saveUsageStats: vi.fn(async () => {}) }));
import { FORMATS } from "../../open-sse/translator/formats.js";
import { createPassthroughStreamWithLogger, createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";

const encoder = new TextEncoder();
const source = (parts) => new ReadableStream({ start(c) { for (const p of parts) c.enqueue(encoder.encode(p)); c.close(); } });
async function drain(stream) {
  let text = "";
  const decoder = new TextDecoder();
  for await (const bytes of stream) text += decoder.decode(bytes, { stream: true });
  return text + decoder.decode();
}
const data = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const dataFrames = (text) => text.split(/\n\n/).filter(f => f.startsWith("data: ")).map(f => f.slice(6));

describe("passthrough of protocols without tracked terminal events", () => {
  for (const provider of ["gemini", "antigravity", "vertex"]) {
    it(`${provider} stream is forwarded without synthetic error or [DONE]`, async () => {
      const outcomes = [];
      const frame = data({ candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }] });
      const stream = createPassthroughStreamWithLogger(provider, null, "m", null, {}, (_c, _u, _t, outcome) => outcomes.push(outcome), null, FORMATS.GEMINI);
      const text = await drain(source([frame]).pipeThrough(stream));
      expect(text).toBe(frame);
      expect(text).not.toContain("error");
      expect(text).not.toContain("[DONE]");
      expect(outcomes).toEqual(["completed"]);
    });
  }

  it("non Gemini-family untracked format keeps the single trailing [DONE]", async () => {
    const outcomes = [];
    const frame = data({ candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }] });
    const stream = createPassthroughStreamWithLogger("gemini-cli", null, "m", null, {}, (_c, _u, _t, outcome) => outcomes.push(outcome), null, FORMATS.GEMINI_CLI);
    const text = await drain(source([frame, "data: [DONE]\n\n"]).pipeThrough(stream));
    expect(dataFrames(text)).toHaveLength(2);
    expect(dataFrames(text)[1]).toBe("[DONE]");
    expect(text).not.toContain("\"error\"");
    expect(outcomes).toEqual(["completed"]);
  });
});

describe("OpenAI Chat usage trailer", () => {
  const chunk = (delta, finish = null) => ({ id: "chatcmpl-trailer", object: "chat.completion.chunk", created: 1, choices: [{ index: 0, delta, finish_reason: finish }] });
  const trailer = { id: "chatcmpl-trailer", object: "chat.completion.chunk", created: 1, choices: [], usage: { prompt_tokens: 111, completion_tokens: 222, total_tokens: 333 } };

  it("passthrough forwards trailer before one [DONE] and reports real usage", async () => {
    const reports = [];
    const stream = createPassthroughStreamWithLogger("openai", null, "m", null, { messages: [{ role: "user", content: "x".repeat(8000) }] }, (_c, usage, _t, outcome) => reports.push({ usage, outcome }), null, FORMATS.OPENAI);
    const text = await drain(source([data(chunk({ role: "assistant", content: "hi" })), data(chunk({}, "stop")), data(trailer), "data: [DONE]\n\n"]).pipeThrough(stream));
    const frames = dataFrames(text);
    expect(frames.at(-1)).toBe("[DONE]");
    expect(frames.filter(f => f === "[DONE]")).toHaveLength(1);
    expect(JSON.parse(frames.at(-2))).toMatchObject({ choices: [], usage: { prompt_tokens: 111, completion_tokens: 222 } });
    expect(reports).toHaveLength(1);
    expect(reports[0].outcome).toBe("completed");
    expect(reports[0].usage).toMatchObject({ prompt_tokens: 111, completion_tokens: 222 });
  });

  it("passthrough without trailer still closes with exactly one [DONE]", async () => {
    const stream = createPassthroughStreamWithLogger("openai", null, "m", null, {}, null, null, FORMATS.OPENAI);
    const text = await drain(source([data(chunk({ role: "assistant", content: "hi" })), data(chunk({}, "stop"))]).pipeThrough(stream));
    expect(dataFrames(text).filter(f => f === "[DONE]")).toHaveLength(1);
    expect(text).not.toContain("\"error\"");
  });

  it("translated Chat to Chat keeps the trailer", async () => {
    const stream = createSSETransformStreamWithLogger(FORMATS.OPENAI, FORMATS.OPENAI, "openai");
    const text = await drain(source([data(chunk({ role: "assistant", content: "hi" })), data(chunk({}, "stop")), data(trailer), "data: [DONE]\n\n"]).pipeThrough(stream));
    const frames = dataFrames(text);
    expect(frames.filter(f => f === "[DONE]")).toHaveLength(1);
    expect(frames.some(f => f !== "[DONE]" && JSON.parse(f).usage?.completion_tokens === 222)).toBe(true);
  });
});
