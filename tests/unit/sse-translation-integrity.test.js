import { describe, expect, it, vi } from "vitest";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";

vi.mock("@/lib/usageDb.js", () => ({ trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async () => {}) }));

const encoder = new TextEncoder();
const chat = (delta, finish = null, extra = {}) => `data: ${JSON.stringify({ id: "chatcmpl-integrity", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
const claude = event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
const responses = (type, extra = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`;
const responsesStart = responses("response.created", { response: { id: "resp_translate", status: "in_progress" } }) + responses("response.output_text.delta", { delta: "partial" });
const claudeStart = claude({ type: "message_start", message: { id: "msg_integrity", role: "assistant", content: [], usage: { input_tokens: 1, output_tokens: 0 } } });
const claudeText = claude({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) + claude({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } });
const claudeEnd = reason => claude({ type: "content_block_stop", index: 0 }) + claude({ type: "message_delta", delta: { stop_reason: reason }, usage: { output_tokens: 1 } }) + claude({ type: "message_stop" });

async function run(provider, client, parts) {
  const body = new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(encoder.encode(part)); controller.close(); } });
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of body.pipeThrough(createSSETransformStreamWithLogger(provider, client, "integrity", null, null, "model"))) text += decoder.decode(chunk, { stream: true });
  return summarize(text + decoder.decode());
}
function summarize(text) {
  const events = [];
  for (const raw of text.split("\n\n")) {
    const lines = raw.split("\n");
    const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    if (!data) continue;
    if (data === "[DONE]") { events.push("DONE"); continue; }
    try {
      const parsed = JSON.parse(data);
      const event = lines.find(line => line.startsWith("event:"))?.slice(6).trim() || parsed.type || (parsed.error ? "chat.error" : "chat.chunk");
      events.push(event === "chat.chunk" && parsed.choices?.[0]?.finish_reason ? `finish:${parsed.choices[0].finish_reason}` : event);
    } catch { events.push("malformed"); }
  }
  return events;
}
const count = (events, name) => events.filter(event => event === name).length;
const responseTerminals = events => events.filter(event => ["response.completed", "response.failed", "response.incomplete"].includes(event));

describe("Chat and Claude upstream to Responses client", () => {
  it("Chat EOF without finish_reason fails instead of completing", async () => {
    const events = await run(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, [chat({ role: "assistant", content: "partial" })]);
    expect(responseTerminals(events)).toEqual(["response.failed"]);
  });

  it("Chat DONE without finish_reason fails instead of completing", async () => {
    const events = await run(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, [chat({ role: "assistant", content: "partial" }), "data: [DONE]\n\n"]);
    expect(responseTerminals(events)).toEqual(["response.failed"]);
  });

  it("Chat length maps to response.incomplete", async () => {
    const events = await run(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, [chat({ role: "assistant", content: "partial" }), chat({}, "length"), "data: [DONE]\n\n"]);
    expect(responseTerminals(events)).toEqual(["response.incomplete"]);
  });

  it("Claude EOF without message_stop fails", async () => {
    const events = await run(FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES, [claudeStart, claudeText]);
    expect(responseTerminals(events)).toEqual(["response.failed"]);
  });

  it("Claude max_tokens maps to response.incomplete", async () => {
    const events = await run(FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES, [claudeStart, claudeText, claudeEnd("max_tokens")]);
    expect(responseTerminals(events)).toEqual(["response.incomplete"]);
  });

  it("Claude error event maps to one response.failed", async () => {
    const events = await run(FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES, [claudeStart, claude({ type: "error", error: { type: "overloaded_error", message: "upstream failure" } })]);
    expect(responseTerminals(events)).toEqual(["response.failed"]);
  });

  it("Claude completed stream produces exactly one completion", async () => {
    const events = await run(FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES, [claudeStart, claudeText, claudeEnd("end_turn")]);
    expect(responseTerminals(events)).toEqual(["response.completed"]);
  });
});

describe("Responses upstream to Chat and Claude clients", () => {
  it("Responses failure becomes Chat API error and one DONE, never stop", async () => {
    const events = await run(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, [responsesStart, responses("response.failed", { response: { id: "resp_translate", status: "failed", error: { type: "server_error", message: "upstream failure" } } })]);
    expect({ error: count(events, "chat.error"), done: count(events, "DONE"), stop: count(events, "finish:stop") }).toEqual({ error: 1, done: 1, stop: 0 });
    expect(events.at(-1)).toBe("DONE");
  });

  it("Responses EOF without terminal becomes Chat error and one DONE", async () => {
    const events = await run(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, [responsesStart]);
    expect({ error: count(events, "chat.error"), done: count(events, "DONE"), stop: count(events, "finish:stop") }).toEqual({ error: 1, done: 1, stop: 0 });
  });

  it("Responses incomplete reaches Chat as length plus one DONE", async () => {
    const events = await run(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, [responsesStart, responses("response.incomplete", { response: { id: "resp_translate", status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } })]);
    expect({ length: count(events, "finish:length"), stop: count(events, "finish:stop"), done: count(events, "DONE") }).toEqual({ length: 1, stop: 0, done: 1 });
  });

  it("successful translated Chat stream ends with one DONE", async () => {
    const events = await run(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, [responsesStart, responses("response.completed", { response: { id: "resp_translate", status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })]);
    expect({ stop: count(events, "finish:stop"), done: count(events, "DONE"), last: events.at(-1) }).toEqual({ stop: 1, done: 1, last: "DONE" });
  });

  it("Responses EOF without terminal becomes Claude event: error", async () => {
    const events = await run(FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, [responsesStart]);
    expect({ error: count(events, "error"), stop: count(events, "message_stop") }).toEqual({ error: 1, stop: 0 });
  });

  it("Responses failure becomes Claude event: error", async () => {
    const events = await run(FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, [responsesStart, responses("response.failed", { response: { id: "resp_translate", status: "failed", error: { message: "upstream failure" } } })]);
    expect({ error: count(events, "error"), stop: count(events, "message_stop") }).toEqual({ error: 1, stop: 0 });
  });
});
