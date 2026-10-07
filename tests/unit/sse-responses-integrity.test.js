import { describe, expect, it, vi } from "vitest";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { createSSETransformStreamWithLogger, createPassthroughStreamWithLogger } from "../../open-sse/utils/stream.js";
import { isOpenAIResponsesTerminalEvent } from "../../open-sse/utils/responsesStreamHelpers.js";

vi.mock("@/lib/usageDb.js", () => ({ trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async () => {}) }));

const encoder = new TextEncoder();
const frame = (type, extra = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`;
const created = frame("response.created", { response: { id: "resp_integrity", status: "in_progress" }, sequence_number: 1 });
const delta = frame("response.output_text.delta", { delta: "càfé", sequence_number: 2 });
const completed = frame("response.completed", { response: { id: "resp_integrity", status: "completed" }, sequence_number: 3 });
const incomplete = frame("response.incomplete", { response: { id: "resp_integrity", status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }, sequence_number: 3 });
const done = "data: [DONE]\n\n";

function source(parts, error) {
  let cursor = 0;
  return new ReadableStream({
    pull(controller) {
      if (cursor < parts.length) {
        const part = parts[cursor++];
        controller.enqueue(typeof part === "string" ? encoder.encode(part) : part);
      } else if (error) controller.error(Object.assign(new Error("connection lost"), { code: "ECONNRESET" }));
      else controller.close();
    },
  });
}
async function collect(body) {
  const decoder = new TextDecoder();
  let result = "";
  for await (const chunk of body) result += decoder.decode(chunk, { stream: true });
  return result + decoder.decode();
}
function inspect(body) {
  const events = [];
  for (const raw of body.replaceAll("\r\n", "\n").split("\n\n")) {
    const fields = raw.split("\n");
    const data = fields.filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    if (!data) continue;
    if (data === "[DONE]") { events.push({ type: "DONE" }); continue; }
    let parsed;
    try { parsed = JSON.parse(data); } catch { events.push({ type: "malformed" }); continue; }
    const name = fields.find(line => line.startsWith("event:"))?.slice(6).trim() || parsed.type;
    events.push({ type: name, id: parsed.response?.id, sequence: parsed.sequence_number, status: parsed.response?.status, error: Boolean(parsed.response?.error || parsed.error), delta: parsed.delta, usage: parsed.response?.usage || parsed.usage });
  }
  return events;
}
const types = events => events.map(event => event.type);
const terminal = events => events.filter(event => ["response.completed", "response.failed", "response.incomplete", "error"].includes(event.type));
const transform = (parts, mode = "translate") => collect(source(parts).pipeThrough(mode === "passthrough"
  ? createPassthroughStreamWithLogger("codex")
  : createSSETransformStreamWithLogger(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI_RESPONSES, "codex"))).then(inspect);

// Port of eight proven sse-correctness-audit failures: all assertions concern
// structured events, never raw SSE (including on test failure).
describe("Responses stream integrity — audit regressions", () => {
  it("treats response.incomplete as terminal, without synthetic failure", async () => {
    const events = await transform([created, incomplete]);
    expect(types(terminal(events))).toEqual(["response.incomplete"]);
  });

  it("passthrough EOF without terminal synthesizes failure", async () => {
    const events = await transform([created, delta], "passthrough");
    expect(types(terminal(events))).toEqual(["response.failed"]);
  });

  it("synthetic failure preserves original response ID and increases sequence", async () => {
    const events = await transform([created, delta]);
    const failed = events.find(event => event.type === "response.failed");
    expect({ id: failed?.id, sequenceIncreases: failed?.sequence > 2, error: failed?.error }).toEqual({ id: "resp_integrity", sequenceIncreases: true, error: true });
  });

  it("assembles multiline data before parsing terminal JSON", async () => {
    const multiline = 'event: response.completed\ndata: {"type":"response.completed",\ndata: "response":{"id":"resp_integrity","status":"completed"},"sequence_number":3}\n\n';
    const events = await transform([created, multiline]);
    expect(types(terminal(events))).toEqual(["response.completed"]);
  });
});

describe("native Responses terminal matrix", () => {
  for (const [name, parts, expected] of [
    ["normal EOF", [created, delta, completed], "response.completed"],
    ["completed then DONE", [created, completed, done], "response.completed"],
    ["incomplete then DONE", [created, incomplete, done], "response.incomplete"],
    ["early EOF", [created, delta], "response.failed"],
    ["DONE without terminal", [created, delta, done], "response.failed"],
    ["DONE only", [done], "response.failed"],
    ["empty EOF", [], "response.failed"],
    ["event error", [created, frame("error", { error: { message: "upstream failure" } })], "error"],
    ["status-only incomplete", [created, 'data: {"response":{"id":"resp_integrity","status":"incomplete"}}\n\n'], "response.incomplete"],
  ]) it(name, async () => {
    const events = await transform(parts);
    expect(types(terminal(events))).toEqual([expected]);
    expect(types(events).filter(type => type === "DONE").length).toBeLessThanOrEqual(1);
  });

  it("duplicate terminal and DONE do not duplicate outcomes or DONE", async () => {
    const events = await transform([created, completed, completed, done, done]);
    expect(types(terminal(events))).toEqual(["response.completed"]);
    expect(types(events).filter(type => type === "DONE").length).toBeLessThanOrEqual(1);
  });

  it("failure after terminal never appended", async () => {
    const events = await transform([created, completed, frame("error", { error: { message: "late reset" } })]);
    expect(types(terminal(events))).toEqual(["response.completed"]);
  });

  it("recognizes incomplete as terminal in shared helper", () => {
    expect(isOpenAIResponsesTerminalEvent("response.incomplete", { response: { status: "incomplete" } })).toBe(true);
  });
});

describe("SSE framing integrity", () => {
  it("parses LF and CRLF frames with comments and keepalives", async () => {
    const events = await transform([": keepalive\r\n\r\n", created.replaceAll("\n", "\r\n"), ": heartbeat\n\n", completed]);
    expect(types(terminal(events))).toEqual(["response.completed"]);
    expect(types(events)).not.toContain("malformed");
  });

  it("parses every byte boundary, preserving UTF-8", async () => {
    const bytes = encoder.encode(created + delta + completed);
    const events = await transform([...bytes].map(byte => Uint8Array.of(byte)));
    expect({ terminals: types(terminal(events)), delta: events.find(event => event.type === "response.output_text.delta")?.delta }).toEqual({ terminals: ["response.completed"], delta: "càfé" });
  });

  it("flushes terminal tail without final newline", async () => {
    const events = await transform([created, completed.trimEnd()]);
    expect(types(terminal(events))).toEqual(["response.completed"]);
  });

  it("malformed terminal frame cannot be mistaken for success", async () => {
    const events = await transform([created, 'event: response.completed\ndata: {broken}\n\n']);
    expect(types(terminal(events))).toEqual(["response.failed"]);
  });

  it("bounds unterminated input and never reports false success", async () => {
    const events = await transform([created, "x".repeat(2 * 1024 * 1024), completed]);
    expect(types(terminal(events))).toEqual(["response.failed"]);
    expect(events.some(event => event.type === "response.completed")).toBe(false);
  });

  it("keeps usage trailer from completed Responses", async () => {
    const events = await transform([created, frame("response.completed", { response: { id: "resp_integrity", status: "completed", usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } }, sequence_number: 3 })]);
    expect(events.find(event => event.type === "response.completed")?.usage).toMatchObject({ input_tokens: 2, output_tokens: 3 });
  });
});
