import { FORMATS } from "../translator/formats.js";
import { formatSSE, buildStreamErrorBytes } from "./streamHelpers.js";
import { SSE_DONE } from "./sseConstants.js";

const encoder = new TextEncoder();
const RESPONSE_OUTCOMES = {
  "response.completed": "completed",
  "response.done": "completed",
  "response.incomplete": "incomplete",
  "response.failed": "failed",
  error: "failed"
};

/** One terminal decision for the entire lifetime of a single response stream. */
export function createStreamTerminalState(clientFormat = FORMATS.OPENAI) {
  let outcome = "none";
  let responseId = null;
  let chatId = null;
  let messageId = null;
  let lastSeq = -1;
  let doneSent = false;
  let chatFinish = null;
  let claudeStop = null;
  let claudeStopped = false;

  const state = {
    clientFormat,
    get outcome() { return outcome; },
    get responseId() { return responseId; },
    get chatId() { return chatId; },
    get messageId() { return messageId; },
    get lastSeq() { return lastSeq; },
    get doneSent() { return doneSent; },
    get chatFinish() { return chatFinish; },
    get claudeStop() { return claudeStop; },
    get claudeStopped() { return claudeStopped; },
    get terminal() { return outcome !== "none"; },
    observe(chunk, eventName = null, format = clientFormat) {
      if (!chunk || typeof chunk !== "object") return;
      if (format === FORMATS.OPENAI_RESPONSES) {
        if (typeof chunk.response?.id === "string") responseId = chunk.response.id;
        if (typeof chunk.sequence_number === "number" && Number.isFinite(chunk.sequence_number)) {
          lastSeq = Math.max(lastSeq, chunk.sequence_number);
        }
        const kind = RESPONSE_OUTCOMES[eventName || chunk.type]
          || (chunk.response?.status === "completed" ? "completed" : chunk.response?.status === "incomplete" ? "incomplete" : chunk.response?.status === "failed" ? "failed" : null);
        if (kind) state.finish(kind);
      } else if (format === FORMATS.OPENAI) {
        if (typeof chunk.id === "string") chatId = chunk.id;
        const finish = chunk.choices?.find(c => c?.finish_reason)?.finish_reason;
        if (finish) {
          chatFinish = finish;
          state.finish(finish === "length" ? "incomplete" : "completed");
        }
        if (chunk.error) state.finish("failed");
      } else if (format === FORMATS.CLAUDE) {
        if (typeof chunk.message?.id === "string") messageId = chunk.message.id;
        if (chunk.type === "message_delta" && chunk.delta?.stop_reason) claudeStop = chunk.delta.stop_reason;
        if (chunk.type === "message_stop") {
          claudeStopped = true;
          if (claudeStop) state.finish(claudeStop === "max_tokens" ? "incomplete" : "completed");
        }
        if (chunk.type === "error") state.finish("failed");
      }
    },
    finish(kind) {
      if (outcome !== "none") return false;
      if (!["completed", "incomplete", "failed"].includes(kind)) return false;
      outcome = kind;
      return true;
    },
    done() {
      if (doneSent) return false;
      doneSent = true;
      return true;
    },
    /** Used on EOF, reset or stall only if no terminal outcome was emitted. */
    failureBytes(statusCode = 502, message = "Upstream stream closed before a terminal event") {
      if (!state.finish("failed")) return null;
      if (clientFormat !== FORMATS.OPENAI_RESPONSES) {
        if (clientFormat !== FORMATS.CLAUDE) state.done();
        return buildStreamErrorBytes(statusCode, message, clientFormat);
      }
      const failure = {
        type: "response.failed",
        sequence_number: lastSeq + 1,
        response: {
          id: responseId || `resp_${Date.now()}`,
          status: "failed",
          error: { type: "stream_error", code: "stream_disconnected", message }
        }
      };
      let text = formatSSE({ event: "response.failed", data: failure }, clientFormat);
      if (state.done()) text += SSE_DONE;
      return encoder.encode(text);
    },
    doneBytes() {
      return state.done() ? encoder.encode(SSE_DONE) : null;
    }
  };
  return state;
}
