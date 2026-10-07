import { createSSEFrameParser, parseSSEFrame } from "../utils/sseFrameParser.js";

const EMPTY_USAGE = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

function conversionError(code) {
  const error = new Error("Upstream Responses stream did not complete successfully");
  error.code = code;
  return error;
}

/**
 * Convert a provider-forced Responses SSE stream into a JSON response. A partial
 * stream is never a successful response: EOF without a terminal or an explicit
 * failure rejects so callers can return a structured gateway error.
 */
export async function convertResponsesStreamToJson(stream) {
  if (!stream || typeof stream.getReader !== "function") {
    throw conversionError("missing_stream");
  }

  const reader = stream.getReader();
  const parser = createSSEFrameParser();
  const state = {
    responseId: "",
    created: Math.floor(Date.now() / 1000),
    model: null,
    usage: { ...EMPTY_USAGE },
    items: new Map(),
    terminal: null,
    incompleteDetails: null,
    terminalOutput: null,
    sawOutput: false,
  };

  const processFrame = (frame) => {
    if (state.terminal) return; // A trailing frame cannot change an established outcome.
    const parsed = parseSSEFrame(frame);
    if (!parsed || parsed.done) return;
    const event = frame.event || parsed.type;
    if ((event === "response.output_text.delta" || event === "response.reasoning_summary_text.delta" ||
         event === "response.function_call_arguments.delta" || event === "response.custom_tool_call_input.delta") &&
        typeof parsed.delta === "string" && parsed.delta.length > 0) {
      state.sawOutput = true;
    }
    if ((event === "response.output_text.done" || event === "response.reasoning_summary_text.done") &&
        typeof parsed.text === "string" && parsed.text.length > 0) state.sawOutput = true;
    if (event === "response.function_call_arguments.done" &&
        typeof parsed.arguments === "string" && parsed.arguments.length > 0) state.sawOutput = true;
    if (event === "response.custom_tool_call_input.done" &&
        typeof parsed.input === "string" && parsed.input.length > 0) state.sawOutput = true;
    if (event === "response.output_item.added" &&
        ["function_call", "custom_tool_call"].includes(parsed.item?.type)) state.sawOutput = true;
    if (event === "response.created") {
      state.responseId = parsed.response?.id || state.responseId;
      state.created = parsed.response?.created_at || state.created;
      state.model = parsed.response?.model || state.model;
    } else if (event === "response.output_item.done") {
      const index = parsed.output_index ?? 0;
      if (parsed.item && Number.isSafeInteger(index) && index >= 0) {
        state.items.set(index, parsed.item);
      }
    } else if (event === "response.completed" || event === "response.done" ||
               event === "response.incomplete" || event === "response.failed") {
      const response = parsed.response || {};
      state.responseId = response.id || state.responseId;
      state.created = response.created_at || state.created;
      state.model = response.model || state.model;
      if (response.usage) state.usage = { ...EMPTY_USAGE, ...response.usage };
      if (Array.isArray(response.output)) state.terminalOutput = response.output;
      state.incompleteDetails = response.incomplete_details || null;
      state.terminal = response.status || (event === "response.done" ? "completed" : event.slice("response.".length));
    } else if (event === "error" || parsed.error) {
      state.terminal = "failed";
    }
  };

  let completedRead = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) { completedRead = true; break; }
      for (const frame of parser.push(value)) processFrame(frame);
      if (state.terminal) break;
    }
    if (!state.terminal) {
      for (const frame of parser.finish()) processFrame(frame);
    }
  } finally {
    if (!completedRead) {
      try { await reader.cancel(); } catch { /* keep original transport/parser error */ }
    }
    reader.releaseLock();
  }

  if (state.terminal !== "completed" && state.terminal !== "incomplete") {
    throw conversionError(state.terminal === "failed" ? "upstream_failed" : "missing_terminal");
  }
  const completedItems = [...state.items.entries()]
    .sort(([a], [b]) => a - b).map(([, item]) => item);
  const output = state.terminalOutput?.length ? state.terminalOutput : completedItems;
  if (!output.length && state.sawOutput) throw conversionError("missing_output");

  return {
    id: state.responseId || `resp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    object: "response",
    created_at: state.created,
    ...(state.model ? { model: state.model } : {}),
    status: state.terminal,
    ...(state.terminal === "incomplete" ? { incomplete_details: state.incompleteDetails } : {}),
    output,
    usage: state.usage,
  };
}
