import { describe, expect, it, vi, beforeEach } from "vitest";

// Real pending counter semantics (decrement clamps at 0, per model + account),
// so a double release on a shared model/account is observable.
const pending = vi.hoisted(() => ({ byModel: {}, calls: [] }));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn((model, provider, connectionId, started) => {
    const key = `${connectionId}|${model} (${provider})`;
    pending.calls.push(started ? "+" : "-");
    pending.byModel[key] = Math.max(0, (pending.byModel[key] || 0) + (started ? 1 : -1));
  }),
  appendRequestLog: vi.fn(async () => {}),
}));

import { trackPendingRequest } from "@/lib/usageDb.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { createPassthroughStreamWithLogger, createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";
import { createStreamController, pipeWithDisconnect } from "../../open-sse/utils/streamHandler.js";
import { buildAbortedResponsesTerminalBytes } from "../../open-sse/utils/responsesStreamHelpers.js";

const encoder = new TextEncoder();
const MODEL = "gpt-test";
const PROVIDER = "codex";
const CONN = "conn-1";
const KEY = `${CONN}|${MODEL} (${PROVIDER})`;
const ev = (type, extra = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`;
const created = ev("response.created", { response: { id: "resp_acc", status: "in_progress" }, sequence_number: 1 });
const delta = ev("response.output_text.delta", { delta: "partial text", sequence_number: 2 });
const completed = ev("response.completed", { response: { id: "resp_acc", status: "completed", usage: { input_tokens: 5, output_tokens: 7 } }, sequence_number: 3 });

// Mirrors chatCore.js: request start increments, controller callbacks release.
function startRequest({ clientFormat = FORMATS.OPENAI_RESPONSES, externalDisconnect = null } = {}) {
  trackPendingRequest(MODEL, PROVIDER, CONN, true);
  const controller = createStreamController({
    provider: PROVIDER, model: MODEL, log: { errorLine() {}, line() {} },
    onDisconnect: (reason) => { trackPendingRequest(MODEL, PROVIDER, CONN, false); externalDisconnect?.(reason); },
    onError: () => trackPendingRequest(MODEL, PROVIDER, CONN, false),
  });
  const completions = [];
  const onDone = (content, usage, ttft, outcome) => completions.push({ content, usage, outcome });
  // Chat -> Chat is passthrough (waits for a usage trailer / [DONE]); keep the
  // pending key identical by passing the same model/provider/connection.
  const transform = clientFormat === FORMATS.OPENAI
    ? createPassthroughStreamWithLogger(PROVIDER, null, MODEL, CONN, {}, onDone, null, FORMATS.OPENAI)
    : createSSETransformStreamWithLogger(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI_RESPONSES, PROVIDER, null, null, MODEL, CONN, {}, onDone);
  return { controller, transform, completions };
}
const chatChunk = (delta, finish = null) => `data: ${JSON.stringify({ id: "chatcmpl-acc", object: "chat.completion.chunk", created: 1, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const chatFinish = chatChunk({ role: "assistant", content: "hi" }) + chatChunk({}, "stop");
const heldOpen = (parts, signal) => new ReadableStream({
  start(c) {
    c.enqueue(encoder.encode(parts));
    signal.addEventListener("abort", () => c.error(new Error("aborted")), { once: true });
  },
  cancel() {},
});
async function drain(stream) {
  let text = "";
  const decoder = new TextDecoder();
  for await (const bytes of stream) text += decoder.decode(bytes, { stream: true });
  return text + decoder.decode();
}

beforeEach(() => {
  pending.byModel = {};
  pending.calls = [];
  // A second, concurrent request on the same model/account that must keep its slot.
  trackPendingRequest(MODEL, PROVIDER, CONN, true);
  pending.calls = [];
});

describe("stream termination accounting (pending slot, request detail, usage)", () => {
  it("completed stream releases its pending slot exactly once and reports completed", async () => {
    const { controller, transform, completions } = startRequest();
    const body = new ReadableStream({ start(c) { c.enqueue(encoder.encode(created + completed)); c.close(); } });
    await drain(pipeWithDisconnect({ body }, transform, controller, buildAbortedResponsesTerminalBytes, 1000));
    expect(pending.calls).toEqual(["+", "-"]);
    expect(pending.byModel[KEY]).toBe(1);
    expect(completions.map(c => c.outcome)).toEqual(["completed"]);
  });

  it("client cancel releases pending once, keeps the concurrent slot, and closes request detail as failed", async () => {
    const { controller, transform, completions } = startRequest();
    const body = new ReadableStream({ start(c) { c.enqueue(encoder.encode(created + delta)); }, cancel() {} });
    const reader = pipeWithDisconnect({ body }, transform, controller, buildAbortedResponsesTerminalBytes, 1000).getReader();
    expect((await reader.read()).done).toBe(false);
    expect((await reader.read()).done).toBe(false);
    await reader.cancel("client closed");
    expect(pending.calls).toEqual(["+", "-"]);
    expect(pending.byModel[KEY]).toBe(1);
    expect(completions).toHaveLength(1);
    expect(completions[0].outcome).toBe("failed");
  });

  it("upstream reset finalizes request detail as failed and releases pending once", async () => {
    const { controller, transform, completions } = startRequest();
    let sent = false;
    const body = new ReadableStream({
      pull(c) {
        if (!sent) { sent = true; c.enqueue(encoder.encode(created + delta)); return; }
        c.error(Object.assign(new Error("connection lost"), { code: "ECONNRESET" }));
      },
    });
    const text = await drain(pipeWithDisconnect({ body }, transform, controller, buildAbortedResponsesTerminalBytes, 1000));
    expect(text).toContain("response.failed");
    expect(pending.calls).toEqual(["+", "-"]);
    expect(pending.byModel[KEY]).toBe(1);
    expect(completions.map(c => c.outcome)).toEqual(["failed"]);
  });

  it("stall timeout finalizes request detail as failed and releases pending once", async () => {
    const { controller, transform, completions } = startRequest();
    const body = new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode(created + delta));
        controller.signal.addEventListener("abort", () => c.error(new Error("aborted")), { once: true });
      },
    });
    const text = await drain(pipeWithDisconnect({ body }, transform, controller, buildAbortedResponsesTerminalBytes, 30));
    expect(text).toContain("response.failed");
    expect(pending.calls).toEqual(["+", "-"]);
    expect(pending.byModel[KEY]).toBe(1);
    expect(completions.map(c => c.outcome)).toEqual(["failed"]);
  }, 2000);

  it("cancel after a completed terminal does not release pending a second time", async () => {
    const { controller, transform, completions } = startRequest();
    const body = new ReadableStream({ start(c) { c.enqueue(encoder.encode(created + completed)); }, cancel() {} });
    const reader = pipeWithDisconnect({ body }, transform, controller, buildAbortedResponsesTerminalBytes, 1000).getReader();
    expect((await reader.read()).done).toBe(false);
    await reader.cancel("client closed after terminal");
    // Responses clients close right after the terminal: finalize() already
    // released, so the late cancel must not decrement the concurrent slot.
    expect(completions.map(c => c.outcome)).toEqual(["completed"]);
    expect(pending.calls).toEqual(["+", "-"]);
    expect(pending.byModel[KEY]).toBe(1);
    expect(controller.signal.aborted).toBe(true);
  });

  it("Responses terminal then held-open idle upstream: stall does not release pending again", async () => {
    const { controller, transform, completions } = startRequest();
    const text = await drain(pipeWithDisconnect({ body: heldOpen(created + completed, controller.signal) }, transform, controller, buildAbortedResponsesTerminalBytes, 30));
    expect(text).not.toContain("response.failed");
    expect(completions.map(c => c.outcome)).toEqual(["completed"]);
    expect(pending.calls).toEqual(["+", "-"]);
    expect(pending.byModel[KEY]).toBe(1);
  }, 2000);

  for (const kind of ["stall", "reset", "cancel"]) {
    it(`Chat finish_reason then ${kind} before trailer/[DONE] releases pending exactly once`, async () => {
      const { controller, transform, completions } = startRequest({ clientFormat: FORMATS.OPENAI });
      let body;
      if (kind === "reset") {
        let sent = false;
        body = new ReadableStream({ pull(c) { if (!sent) { sent = true; c.enqueue(encoder.encode(chatFinish)); return; } c.error(Object.assign(new Error("reset"), { code: "ECONNRESET" })); } });
      } else body = heldOpen(chatFinish, controller.signal);
      const stream = pipeWithDisconnect({ body }, transform, controller, (m) => encoder.encode(`data: {"error":{"message":"${m}"}}\n\n`), kind === "stall" ? 30 : 1000);
      if (kind === "cancel") {
        const reader = stream.getReader();
        expect((await reader.read()).done).toBe(false);
        await reader.cancel("client closed");
      } else {
        const text = await drain(stream);
        expect(text).not.toContain("\"error\"");
      }
      expect(completions).toHaveLength(1);
      expect(completions[0].outcome).toBe("completed");
      expect(pending.calls).toEqual(["+", "-"]);
      expect(pending.byModel[KEY]).toBe(1);
    }, 2000);
  }

  it("a throwing external disconnect hook still finalizes accounting", async () => {
    const { controller, transform, completions } = startRequest({ externalDisconnect: () => { throw new Error("hook failed"); } });
    const body = new ReadableStream({ start(c) { c.enqueue(encoder.encode(created + delta)); }, cancel() {} });
    const reader = pipeWithDisconnect({ body }, transform, controller, buildAbortedResponsesTerminalBytes, 1000).getReader();
    expect((await reader.read()).done).toBe(false);
    await reader.cancel("client closed");
    expect(completions.map(c => c.outcome)).toEqual(["failed"]);
    expect(pending.calls).toEqual(["+", "-"]);
    expect(pending.byModel[KEY]).toBe(1);
  });
});

describe("request detail and usage persistence for an interrupted stream", () => {
  it("cancelled stream moves detail out of pending with status error and still saves usage", async () => {
    vi.resetModules();
    const saved = { details: [], usage: [] };
    vi.doMock("@/lib/usageDb.js", () => ({
      trackPendingRequest: vi.fn(),
      appendRequestLog: vi.fn(async () => {}),
      saveRequestDetail: vi.fn(async (detail) => { saved.details.push(detail); }),
      saveRequestUsage: vi.fn(async (usage) => { saved.usage.push(usage); }),
    }));
    try {
      const { buildOnStreamComplete } = await import("../../open-sse/handlers/chatCore/streamingHandler.js");
      const { onStreamComplete, streamDetailId } = buildOnStreamComplete({ provider: PROVIDER, model: MODEL, connectionId: CONN, requestStartTime: Date.now(), body: { model: MODEL }, stream: true });
      onStreamComplete({ content: "partial", thinking: null }, { prompt_tokens: 5, completion_tokens: 3 }, Date.now(), "failed");
      await Promise.resolve();
      expect(saved.details).toHaveLength(1);
      expect(saved.details[0]).toMatchObject({ id: streamDetailId, status: "error", response: { outcome: "failed" } });
      expect(saved.usage).toHaveLength(1);
      expect(saved.usage[0].tokens).toMatchObject({ prompt_tokens: 5, completion_tokens: 3 });
    } finally {
      vi.doUnmock("@/lib/usageDb.js");
      vi.resetModules();
    }
  });
});
