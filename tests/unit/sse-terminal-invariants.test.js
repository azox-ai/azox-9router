import { describe, expect, it, vi } from "vitest";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";
import { createDisconnectAwareStream, createStreamController, pipeWithDisconnect } from "../../open-sse/utils/streamHandler.js";
import { buildAbortedResponsesTerminalBytes } from "../../open-sse/utils/responsesStreamHelpers.js";
import { buildStreamErrorBytes } from "../../open-sse/utils/streamHelpers.js";

vi.mock("@/lib/usageDb.js", () => ({ trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async () => {}) }));

const encoder = new TextEncoder();
const response = (type, extra = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`;
const start = response("response.created", { response: { id: "resp_terminal", status: "in_progress" }, sequence_number: 1 });
const complete = response("response.completed", { response: { id: "resp_terminal", status: "completed" }, sequence_number: 2 });
const delta = response("response.output_text.delta", { delta: "partial", sequence_number: 2 });
const makeController = (options = {}) => createStreamController({ provider: "codex", model: "test", log: { errorLine() {}, line() {} }, ...options });
function upstream(parts, { reset = false, hangOnSignal } = {}) {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < parts.length) { controller.enqueue(encoder.encode(parts[index++])); return; }
      if (hangOnSignal) {
        hangOnSignal.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
      } else if (reset) controller.error(Object.assign(new Error("connection lost"), { code: "ECONNRESET" }));
      else controller.close();
    },
    cancel() { /* client cancellation cleans up this stream */ },
  });
}
const transform = (providerFormat, clientFormat) => createSSETransformStreamWithLogger(providerFormat, clientFormat, "codex");
async function read(stream) {
  let text = "";
  const decoder = new TextDecoder();
  for await (const chunk of stream) text += decoder.decode(chunk, { stream: true });
  return summarize(text + decoder.decode());
}
function summarize(text) {
  const events = [];
  for (const raw of text.split(/\r?\n\r?\n/)) {
    const lines = raw.split(/\r?\n/);
    const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    if (!data) continue;
    if (data === "[DONE]") { events.push({ type: "DONE" }); continue; }
    try {
      const item = JSON.parse(data);
      const type = lines.find(line => line.startsWith("event:"))?.slice(6).trim() || (item.error ? "error" : item.type || "chunk");
      events.push({ type, id: item.response?.id, sequence: item.sequence_number, error: Boolean(item.error || item.response?.error) });
    } catch { events.push({ type: "malformed" }); }
  }
  return events;
}
const types = events => events.map(event => event.type);
const terminal = events => events.filter(event => ["response.completed", "response.failed", "response.incomplete", "error"].includes(event.type));
const pipe = (parts, { reset, clientFormat = FORMATS.OPENAI_RESPONSES, stall, hang } = {}) => {
  const ctrl = makeController();
  const source = upstream(parts, { reset, hangOnSignal: hang ? ctrl.signal : undefined });
  return { ctrl, body: pipeWithDisconnect({ body: source }, transform(FORMATS.OPENAI_RESPONSES, clientFormat), ctrl, clientFormat === FORMATS.OPENAI_RESPONSES ? buildAbortedResponsesTerminalBytes : msg => buildStreamErrorBytes(504, msg, clientFormat), stall ?? 1000) };
};

describe("terminal state across transform and disconnect wrappers", () => {
  // Fifth proven audit failure: no synthetic response.failed after completed + reset.
  it("does not append failure after completed then transport reset", async () => {
    const events = await read(pipe([start, complete], { reset: true }).body);
    expect(types(terminal(events))).toEqual(["response.completed"]);
  });

  it("preserves ID and sequence on pre-terminal transport reset", async () => {
    const events = await read(pipe([start, delta], { reset: true }).body);
    const failed = events.find(event => event.type === "response.failed");
    expect({ terminals: types(terminal(events)), id: failed?.id, increases: failed?.sequence > 2, error: failed?.error, done: types(events).filter(x => x === "DONE").length }).toEqual({ terminals: ["response.failed"], id: "resp_terminal", increases: true, error: true, done: 1 });
  });

  it("does not append failure after incomplete then transport reset", async () => {
    const truncated = response("response.incomplete", { response: { id: "resp_terminal", status: "incomplete" }, sequence_number: 2 });
    const events = await read(pipe([start, truncated], { reset: true }).body);
    expect(types(terminal(events))).toEqual(["response.incomplete"]);
  });

  it("stall after partial output yields exactly one failure", async () => {
    const events = await read(pipe([start, delta], { hang: true, stall: 35 }).body);
    expect({ terminals: types(terminal(events)), done: types(events).filter(x => x === "DONE").length }).toEqual({ terminals: ["response.failed"], done: 1 });
  }, 2000);

  it("raw-byte keepalives prevent false stall while no text delta is emitted", async () => {
    const ctrl = makeController();
    const source = new ReadableStream({
      async start(controller) {
        controller.enqueue(encoder.encode(start));
        for (let i = 0; i < 5; i++) {
          await new Promise(resolve => setTimeout(resolve, 12));
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        }
        controller.enqueue(encoder.encode(complete));
        controller.close();
      },
    });
    const events = await read(pipeWithDisconnect({ body: source }, transform(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI_RESPONSES), ctrl, buildAbortedResponsesTerminalBytes, 40));
    expect(types(terminal(events))).toEqual(["response.completed"]);
  }, 2000);

  it("client cancellation aborts upstream and never attempts to write terminal to closed downstream", async () => {
    const onDisconnect = vi.fn();
    const ctrl = makeController({ onDisconnect });
    const outcomes = [];
    const upstreamCancelled = vi.fn();
    const body = new ReadableStream({
      start(controller) { controller.enqueue(encoder.encode(start)); },
      cancel: upstreamCancelled,
    });
    const trackedTransform = createSSETransformStreamWithLogger(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI_RESPONSES, "codex", null, null, "test", null, {}, (_c, _u, _t, outcome) => outcomes.push(outcome));
    const responseBody = pipeWithDisconnect({ body }, trackedTransform, ctrl, buildAbortedResponsesTerminalBytes, 1000);
    const reader = responseBody.getReader();
    expect((await reader.read()).done).toBe(false);
    await reader.cancel("client closed");
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(ctrl.isConnected()).toBe(false);
    expect(upstreamCancelled).toHaveBeenCalledTimes(1);
    expect(outcomes).toEqual(["failed"]);
  }, 2000);

  it("createDisconnectAwareStream emits no failure when terminal already forwarded", async () => {
    const ctrl = makeController();
    const body = upstream([start, complete], { reset: true }).pipeThrough(transform(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI_RESPONSES));
    const wrapped = createDisconnectAwareStream({ readable: body, writable: { getWriter: () => ({ abort: () => Promise.resolve() }) } }, ctrl, buildAbortedResponsesTerminalBytes);
    const events = await read(wrapped);
    expect(types(terminal(events))).toEqual(["response.completed"]);
  });

  it("pre-terminal reset on Chat client emits error then exactly one DONE", async () => {
    const events = await read(pipe([start, delta], { reset: true, clientFormat: FORMATS.OPENAI }).body);
    expect(types(events).filter(x => x === "error" || x === "DONE")).toEqual(["error", "DONE"]);
  });

  it("pre-terminal reset on Claude client emits event: error without DONE", async () => {
    const events = await read(pipe([start, delta], { reset: true, clientFormat: FORMATS.CLAUDE }).body);
    expect(types(events).filter(x => x === "error" || x === "DONE")).toEqual(["error"]);
  });
});
