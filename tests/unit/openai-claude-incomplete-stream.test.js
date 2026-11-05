// Removing the semantic EOF guard or swallowing its rejection must fail these tests.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSSEStream, createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";
import { createStreamController, pipeWithDisconnect } from "../../open-sse/utils/streamHandler.js";
import { buildStreamErrorBytes } from "../../open-sse/utils/streamHelpers.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { trackPendingRequest, appendRequestLog } from "@/lib/usageDb.js";

// Keep persistence outside this in-memory protocol test; real transform, wrapper and formatter remain active.
vi.mock("@/lib/usageDb.js", () => ({ trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async () => {}) }));
const encoder = new TextEncoder();
const safeMessage = "incomplete upstream stream (missing finish_reason)";
const frame = (value) => `data: ${JSON.stringify(value)}\n\n`;
const chunk = (delta, finish_reason = null) => ({ id: "chatcmpl-fixture", model: "fixture", choices: [{ index: 0, delta, finish_reason }] });
const tool = (args, index = 0, first = true) => chunk({ tool_calls: [{ index, ...(first ? { id: `call_${index}` } : {}), function: { ...(first ? { name: "Read" } : {}), arguments: args } }] });
const finish = frame(chunk({}, "tool_calls"));
const base = '{"file_path":"/fixture/example.txt","offset":"-2","limit":"3000","pages":""}';
const sanitized = '{"file_path":"/fixture/example.txt","offset":0,"limit":2000}';
const parse = (text) => text.split("\n").filter((l) => l.startsWith("data: ") && l.slice(6) !== "[DONE]").map((l) => JSON.parse(l.slice(6)));
const argsDeltas = (events) => events.filter((e) => e.delta?.type === "input_json_delta");
function setup(text, wrapped = true, options = {}) {
  const settled = vi.fn();
  const transform = createSSEStream({ targetFormat: FORMATS.OPENAI, sourceFormat: FORMATS.CLAUDE, provider: "openai", model: "fixture", onStreamComplete: settled, ...options });
  const source = new ReadableStream({ start(c) { for (let i = 0; i < text.length; i += 13) c.enqueue(encoder.encode(text.slice(i, i + 13))); c.close(); } });
  const control = createStreamController({ log: { line: vi.fn(), errorLine: vi.fn() } });
  const error = vi.spyOn(control, "handleError");
  const complete = vi.spyOn(control, "handleComplete");
  const terminal = vi.fn((message) => buildStreamErrorBytes(504, message, FORMATS.CLAUDE));
  const output = wrapped ? pipeWithDisconnect(new Response(source), transform, control, terminal, 1000) : source.pipeThrough(transform);
  return { output, transform, settled, control, error, complete, terminal };
}
async function collect(output) {
  const reader = output.getReader();
  let text = "", error = null;
  try { while (true) { const r = await reader.read(); if (r.done) break; text += new TextDecoder().decode(r.value); } }
  catch (e) { error = e; }
  return { text, events: parse(text), error, reader };
}
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

const incomplete = [
  ["buffered valid args", frame(tool(base))],
  ["DONE is not finish", frame(tool(base)) + "data: [DONE]\n\n"],
  ["tail args without newline", frame(tool(base)).trimEnd()],
  ["text only", frame(chunk({ content: "prefix" }))],
  ["role only", frame(chunk({ role: "assistant" }))],
  ["DONE only", "data: [DONE]\n\n"],
  ["zero chunks", ""],
  ["malformed SSE tail", "data: {not-json"],
  ["two tools without finish", frame(tool(base)) + frame(tool('{"file_path":"/fixture/other.txt"}', 1))],
];
describe("OpenAI upstream to Claude semantic EOF", () => {
  for (const [name, input] of incomplete) {
    it(`transform rejects ${name} without buffered args or success`, async () => {
      const s = setup(input, false);
      const r = await collect(s.output);
      expect(r.error).toMatchObject({ code: "INCOMPLETE_STREAM", message: safeMessage });
      expect(argsDeltas(r.events)).toEqual([]);
      expect(r.events.some((e) => e.type === "message_stop" || e.delta?.stop_reason)).toBe(false);
      expect(s.settled).not.toHaveBeenCalled();
      s.transform.finalizeTerminated();
      expect(s.settled).toHaveBeenCalledTimes(1);
      expect(s.settled.mock.calls[0][3]).toBe("failed");
      expect(trackPendingRequest).toHaveBeenCalledWith("fixture", "openai", null, false);
      expect(trackPendingRequest.mock.calls.filter((call) => call[3] === false)).toHaveLength(1);
      // Content-bearing failures may log estimated usage instead of a null-token row.
      for (const [entry] of appendRequestLog.mock.calls) expect(entry.status).not.toBe("200 OK");
    });
    it(`actual wrapper emits one safe error for ${name}, never completion`, async () => {
      const s = setup(input);
      const r = await collect(s.output);
      expect(r.error).toBeNull();
      expect(s.error).toHaveBeenCalledTimes(1);
      expect(s.error.mock.calls[0][0]).toMatchObject({ code: "INCOMPLETE_STREAM" });
      expect(s.complete).not.toHaveBeenCalled();
      expect(s.settled).toHaveBeenCalledTimes(1);
      expect(s.settled.mock.calls[0][3]).toBe("failed");
      expect(s.terminal).toHaveBeenCalledTimes(1);
      expect(s.terminal.mock.calls[0][0]).toBe(safeMessage);
      expect(argsDeltas(r.events)).toEqual([]);
      expect(r.events.filter((e) => e.type === "error")).toHaveLength(1);
      expect(r.events.at(-1)).toMatchObject({ type: "error", error: { message: safeMessage } });
      expect(r.events.some((e) => e.type === "message_stop" || e.delta?.stop_reason)).toBe(false);
      expect(await r.reader.read()).toEqual({ value: undefined, done: true });
      expect(s.complete).not.toHaveBeenCalled();
    });
  }
  for (const [name, input, expected] of [
    ["normal finish and DONE", frame(tool(base)) + finish + "data: [DONE]\n\n", [sanitized]],
    ["fragmented args", frame(tool(base.slice(0, 20))) + frame(tool(base.slice(20), 0, false)) + finish, [sanitized]],
    ["finish tail without newline", frame(tool(base)) + finish.trimEnd(), [sanitized]],
    ["empty string", frame(tool("")) + finish, []],
    ["literal empty object", frame(tool("{}")) + finish, ["{}"]],
    ["malformed args retain raw fallback, not JSON validation", frame(tool('{"file_path":')) + finish, ['{"file_path":']],
  ]) {
    it(`preserves ${name}`, async () => {
      const s = setup(input); const r = await collect(s.output);
      expect(r.error).toBeNull();
      expect(argsDeltas(r.events).map((e) => e.delta.partial_json)).toEqual(expected);
      expect(r.events.at(-1).type).toBe("message_stop");
      expect(s.settled).toHaveBeenCalledTimes(1);
      expect(s.complete).toHaveBeenCalledTimes(1);
      expect(s.error).not.toHaveBeenCalled();
      expect(s.terminal).not.toHaveBeenCalled();
    });
  }
  it("keeps interleaved tool buffers and block IDs isolated", async () => {
    const s = setup(frame(tool('{"file_path":"/fixture/a')) + frame(tool('{"file_path":"/fixture/b"}', 1)) + frame(tool('"}', 0, false)) + finish);
    const r = await collect(s.output);
    const starts = r.events.filter((e) => e.content_block?.type === "tool_use");
    expect(starts.map((e) => e.content_block.id)).toEqual(["call_0", "call_1"]);
    expect(argsDeltas(r.events).map((e) => [e.index, e.delta.partial_json])).toEqual([[starts[0].index, '{"file_path":"/fixture/a"}'], [starts[1].index, '{"file_path":"/fixture/b"}']]);
    expect(s.error).not.toHaveBeenCalled();
  });
  it("retains usage arriving after finish", async () => {
    const s = setup(frame(tool("{}")) + finish + frame({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } }));
    await collect(s.output);
    expect(s.settled).toHaveBeenCalledTimes(1);
    expect(s.settled.mock.calls[0][1]).toMatchObject({ prompt_tokens: 11, completion_tokens: 7 });
  });
  it("deduplicates terminal output after duplicate finish", async () => {
    const s = setup(frame(tool("{}")) + finish + finish); const r = await collect(s.output);
    expect(r.events.filter((e) => e.type === "message_stop")).toHaveLength(1);
    expect(s.error).not.toHaveBeenCalled();
    expect(s.settled).toHaveBeenCalledTimes(1);
  });
  it.each([[FORMATS.OPENAI, FORMATS.OPENAI], [FORMATS.CLAUDE, FORMATS.CLAUDE]])("does not apply the guard to same-format %s", async (upstream, client) => {
    const s = setup("", true, { targetFormat: upstream, sourceFormat: client });
    await collect(s.output); expect(s.error).not.toHaveBeenCalled(); expect(s.settled).toHaveBeenCalledTimes(1);
  });
});

describe("wrapper keeps abort and reset classification", () => {
  it.each([["ECONNRESET", "socket hang up private payload"], ["AbortError", "aborted private payload"], ["OTHER", "private payload"], ["INCOMPLETE_STREAM", "private payload"]])("maps only typed %s to safe constant", async (code, message) => {
    const e = Object.assign(new Error(message), { code, ...(code === "AbortError" ? { name: "AbortError" } : {}) });
    const source = new ReadableStream({ start(c) { c.error(e); } });
    const control = createStreamController({ log: { line: vi.fn(), errorLine: vi.fn() } });
    const complete = vi.spyOn(control, "handleComplete");
    const output = pipeWithDisconnect(new Response(source), new TransformStream(), control, (msg) => buildStreamErrorBytes(504, msg, FORMATS.CLAUDE), 1000);
    const r = await collect(output);
    expect(r.events).toHaveLength(1);
    expect(r.events[0].error.message).toBe(code === "INCOMPLETE_STREAM" ? safeMessage : "upstream connection lost");
    expect(r.text).not.toContain("private payload");
    expect(complete).not.toHaveBeenCalled();
  });
  it("clears stall timer after incomplete EOF", async () => {
    vi.useFakeTimers(); const s = setup(frame(tool("{}"))); await collect(s.output);
    expect(vi.getTimerCount()).toBe(0); expect(s.control.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2000); expect(s.error).toHaveBeenCalledTimes(1);
  });
  it("retains client cancel cleanup without demanding terminal bytes", async () => {
    vi.useFakeTimers(); let upstream;
    const source = new ReadableStream({ start(c) { upstream = c; }, cancel: vi.fn() });
    const control = createStreamController({ log: { line: vi.fn(), errorLine: vi.fn() } });
    const output = pipeWithDisconnect(new Response(source), new TransformStream(), control, () => encoder.encode("error"), 1000);
    const reader = output.getReader(); await reader.cancel("client left");
    await vi.advanceTimersByTimeAsync(500);
    expect(control.isConnected()).toBe(false); expect(control.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("stall watches raw bytes while transform buffers tool arguments", async () => {
    vi.useFakeTimers(); let upstream;
    const source = new ReadableStream({ start(c) { upstream = c; } });
    const control = createStreamController({ log: { line: vi.fn(), errorLine: vi.fn() } });
    control.signal.addEventListener("abort", () => upstream.error(new DOMException("aborted", "AbortError")));
    const transform = createSSETransformStreamWithLogger(FORMATS.OPENAI, FORMATS.CLAUDE);
    const terminal = vi.fn((msg) => buildStreamErrorBytes(504, msg, FORMATS.CLAUDE));
    const output = pipeWithDisconnect(new Response(source), transform, control, terminal, 1000);
    const result = collect(output);
    upstream.enqueue(encoder.encode(frame(tool('{"file_path":'))));
    await vi.advanceTimersByTimeAsync(900);
    upstream.enqueue(encoder.encode(frame(tool('"/fixture/a"}', 0, false))));
    await vi.advanceTimersByTimeAsync(900);
    expect(control.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(101);
    const r = await result;
    expect(control.signal.aborted).toBe(true); expect(argsDeltas(r.events)).toEqual([]);
    expect(terminal).toHaveBeenCalledTimes(1);
    expect(terminal.mock.calls[0][0]).toBe("stream stall timeout");
    expect(r.events.filter((e) => e.type === "error")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
