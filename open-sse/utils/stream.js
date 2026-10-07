import { translateResponse, initState } from "../translator/index.js";
import { FORMATS } from "../translator/formats.js";
import { PROVIDERS } from "../config/providers.js";
import { trackPendingRequest, appendRequestLog } from "@/lib/usageDb.js";
import { extractUsage, mergeUsage, hasValidUsage, estimateUsage, logUsage, addBufferToUsage, filterUsageForFormat, COLORS } from "./usageTracking.js";
import { hasValuableContent, fixInvalidId, formatSSE } from "./streamHelpers.js";
import { createSSEFrameParser, parseSSEFrame } from "./sseFrameParser.js";
import { createStreamTerminalState } from "./streamTerminalState.js";
import { dbg } from "./debugLog.js";
import { SSE_DONE, SSE_HEADERS, SSE_HEADERS_NO_BUFFER } from "./sseConstants.js";

export { COLORS, formatSSE, SSE_DONE, SSE_HEADERS, SSE_HEADERS_NO_BUFFER };

const encoder = new TextEncoder();
const TRANSLATE = "translate";

/** Frame-aware transformation with a single per-request terminal decision. */
export function createSSEStream(options = {}) {
  const {
    mode = TRANSLATE, targetFormat, sourceFormat, provider = null,
    reqLogger = null, toolNameMap = null, customToolNames = null,
    model = null, connectionId = null, body = null,
    onStreamComplete = null, apiKey = null, credentials = null,
    terminalState = createStreamTerminalState(sourceFormat || PROVIDERS[provider]?.format || FORMATS.OPENAI)
  } = options;
  const providerFormat = targetFormat || PROVIDERS[provider]?.format || FORMATS.OPENAI;
  const clientFormat = sourceFormat || providerFormat;
  const translated = mode === TRANSLATE;
  const sameFormat = providerFormat === clientFormat;
  // Terminal semantics are only defined for these client protocols. Other
  // formats (Gemini family, Ollama, Kiro, ...) keep the pre-existing behaviour:
  // forward frames and never synthesize a failure that the client cannot parse.
  const tracksTerminal = [FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE].includes(clientFormat);
  const isGeminiFamilyProvider = provider === "antigravity" || provider === "gemini" || provider === "vertex";
  const parser = createSSEFrameParser({ ndjson: providerFormat === FORMATS.OLLAMA });
  const logDecoder = reqLogger ? new TextDecoder("utf-8") : null;
  const state = translated ? {
    ...initState(clientFormat), provider, toolNameMap,
    customToolNames: new Set(customToolNames || []), model,
    sessionId: credentials?._clientSessionId || null, targetFormat: providerFormat
  } : null;
  let usage = null;
  let accumulatedContent = "";
  let accumulatedThinking = "";
  let ttftAt = null;
  let upstreamTerminal = false;
  let upstreamClaudeStop = false;
  let upstreamClaudeMessageStopped = false;
  let pendingClaudeTerminal = [];
  let finished = false;
  let emitted = 0;

  function enqueue(controller, output) {
    if (!output) return;
    reqLogger?.appendConvertedChunk?.(output);
    controller.enqueue(encoder.encode(output));
    emitted++;
  }
  function enqueueBytes(controller, bytes) {
    if (bytes) {
      reqLogger?.appendConvertedChunk?.(new TextDecoder().decode(bytes));
      controller.enqueue(bytes);
      emitted++;
    }
  }
  function finalize(pendingAlreadyReleased = false) {
    if (finished) return;
    finished = true;
    // The stream controller's onDisconnect/onError may already have released
    // this request's pending slot; a second decrement would steal another
    // concurrent request's slot on the same model/account.
    if (!pendingAlreadyReleased) trackPendingRequest(model, provider, connectionId, false);
    let finalUsage = state?.usage || usage;
    const contentLength = accumulatedContent.length + accumulatedThinking.length;
    if (!hasValidUsage(finalUsage) && contentLength > 0) {
      finalUsage = estimateUsage(body, contentLength, clientFormat);
      if (state) state.usage = finalUsage;
      else usage = finalUsage;
    }
    if (hasValidUsage(finalUsage)) logUsage(provider || providerFormat, finalUsage, model, connectionId, apiKey);
    else appendRequestLog({ model, provider, connectionId, tokens: null, status: terminalState.outcome === "completed" ? "200 OK" : `FAILED ${terminalState.outcome === "incomplete" ? "incomplete" : 502}` }).catch(() => {});
    onStreamComplete?.({ content: accumulatedContent, thinking: accumulatedThinking }, finalUsage, ttftAt, terminalState.outcome);
  }
  function fail(controller, message = "Upstream stream closed before a terminal event") {
    pendingClaudeTerminal = [];
    if (!tracksTerminal) {
      // No client-parseable error frame exists for this protocol; record the
      // failed outcome for logging/callbacks without corrupting the stream.
      terminalState.finish("failed");
      finalize();
      return;
    }
    enqueueBytes(controller, terminalState.failureBytes(502, message));
    finalize();
  }
  function done(controller) {
    if (clientFormat === FORMATS.CLAUDE) return;
    // Untracked formats: keep bee052ab behaviour (passthrough appends [DONE]
    // except for Gemini-family clients, translated streams never did).
    if (!tracksTerminal && (translated || isGeminiFamilyProvider)) return;
    enqueueBytes(controller, terminalState.doneBytes());
  }
  function accumulate(input) {
    if (!input || typeof input !== "object") return;
    const content = input.choices?.[0]?.delta?.content || input.delta?.text;
    const thinking = input.choices?.[0]?.delta?.reasoning_content || input.delta?.thinking;
    if (typeof content === "string") accumulatedContent += content;
    if (typeof thinking === "string") accumulatedThinking += thinking;
    if (input.candidates?.[0]?.content?.parts) {
      for (const part of input.candidates[0].content.parts) {
        if (typeof part.text === "string") {
          if (part.thought) accumulatedThinking += part.text;
          else accumulatedContent += part.text;
        }
      }
    }
  }
  function observeOutput(item) {
    terminalState.observe(item?.data || item, item?.event, clientFormat);
  }
  const waitsForUsageTrailer = () => providerFormat === FORMATS.OPENAI && clientFormat === FORMATS.OPENAI;
  function outputItem(item, controller, fromClaudeDelta = false) {
    if (item == null) return;
    // The first translator hop can mark a provider failure even when the second
    // hop returns a perfectly ordinary Chat stop chunk. Never emit that chunk.
    if (state?._streamError) return;
    if (!hasValuableContent(item, clientFormat)) return;
    const isFinish = item.type === "message_delta" || item.choices?.some(choice => choice.finish_reason);
    if (state?.finishReason && isFinish) {
      if (!hasValidUsage(item.usage) && accumulatedContent.length + accumulatedThinking.length > 0) {
        const estimated = estimateUsage(body, accumulatedContent.length + accumulatedThinking.length, clientFormat);
        item.usage = filterUsageForFormat(estimated, clientFormat);
        state.usage = estimated;
      } else if (state.usage) {
        item.usage = filterUsageForFormat(addBufferToUsage(state.usage), clientFormat);
      }
    }
    // Claude emits message_delta before message_stop. Until the latter arrives,
    // a finish chunk is provisional and must not be visible as success.
    if (fromClaudeDelta && (item.event === "response.completed" || item.event === "response.incomplete" || item.type === "message_stop" || item.choices?.some(choice => choice.finish_reason))) {
      pendingClaudeTerminal.push(item);
      return;
    }
    if (terminalState.terminal) return;
    const output = formatSSE(item, clientFormat);
    enqueue(controller, output);
    observeOutput(item);
    if (terminalState.terminal) {
      upstreamTerminal = true;
      if (!waitsForUsageTrailer()) {
        done(controller);
        finalize();
      }
    }
  }
  function emitTranslation(input, controller, fromClaudeDelta = false) {
    const result = translateResponse(providerFormat, clientFormat, input, state);
    if (result?._openaiIntermediate) {
      for (const item of result._openaiIntermediate) reqLogger?.appendOpenAIChunk?.(formatSSE(item, FORMATS.OPENAI));
    }
    if (state?._streamError) {
      fail(controller, "Upstream stream failed");
      return;
    }
    for (const item of result || []) outputItem(item, controller, fromClaudeDelta);
  }
  function passthrough(input, frame, controller) {
    // Keep Responses events (including encrypted reasoning and custom tool data)
    // verbatim unless a Chat-specific compatibility fix is actually necessary.
    const isResponse = clientFormat === FORMATS.OPENAI_RESPONSES;
    let changed = false;
    if (!isResponse && input && typeof input === "object" && input.choices) {
      changed = fixInvalidId(input);
      if (!input.object) { input.object = "chat.completion.chunk"; changed = true; }
      if (!input.created) { input.created = Math.floor(Date.now() / 1000); changed = true; }
      if (input.prompt_filter_results !== undefined) { delete input.prompt_filter_results; changed = true; }
      for (const choice of input.choices) {
        if (choice.content_filter_results !== undefined) { delete choice.content_filter_results; changed = true; }
        if (Array.isArray(choice.delta?.tool_calls) && choice.delta.tool_calls.length === 0) {
          delete choice.delta.tool_calls;
          changed = true;
        }
      }
      if (input.choices.some(choice => choice.finish_reason) && !hasValidUsage(input.usage)) {
        const estimated = usage || estimateUsage(body, accumulatedContent.length + accumulatedThinking.length, clientFormat);
        if (hasValidUsage(estimated)) {
          input.usage = filterUsageForFormat(addBufferToUsage(estimated), clientFormat);
          usage = estimated;
          changed = true;
        }
      }
    }
    if (terminalState.terminal) return;
    // A status-only Responses terminal (no event/type) must still be a
    // recognizable terminal for clients: normalize it to a typed event.
    if (isResponse && input && typeof input === "object" && !input.type && !frame.event && ["completed", "incomplete", "failed"].includes(input.response?.status)) {
      input.type = `response.${input.response.status}`;
      changed = true;
    }
    let raw = frame.raw;
    if (!changed && !/\r?\n\r?\n$/.test(raw)) raw = raw.replace(/\r?\n?$/, "\n\n");
    enqueue(controller, changed ? formatSSE(frame.event ? { event: frame.event, data: input } : (isResponse && input.type ? { event: input.type, data: input } : input), clientFormat) : raw);
    terminalState.observe(input, frame.event, clientFormat);
    if (terminalState.terminal) {
      upstreamTerminal = true;
      // Chat clients may still receive a usage-only trailer after finish_reason.
      if (!waitsForUsageTrailer()) {
        done(controller);
        finalize();
      }
    }
  }
  function handleFrame(frame, controller) {
    if (terminalState.terminal) {
      if (!waitsForUsageTrailer() || terminalState.doneSent) return;
      let trailer;
      try { trailer = parseSSEFrame(frame); } catch { return; }
      if (trailer?.done) { done(controller); finalize(); return; }
      if (trailer?.choices?.length === 0 && trailer.usage) {
        // The trailer is the provider's authoritative usage; it replaces any
        // estimate injected into the finish chunk instead of max-merging.
        const real = extractUsage(trailer);
        if (real) {
          usage = real;
          if (state) state.usage = real;
        }
        let raw = frame.raw;
        if (!/\r?\n\r?\n$/.test(raw)) raw = raw.replace(/\r?\n?$/, "\n\n");
        enqueue(controller, translated ? formatSSE(trailer, clientFormat) : raw);
      }
      return;
    }
    const input = parseSSEFrame(frame);
    if (!input) return; // comment, keepalive, retry metadata
    if (input.done === true && providerFormat !== FORMATS.OLLAMA) {
      if (!tracksTerminal) {
        terminalState.finish("completed");
        done(controller);
        finalize();
        return;
      }
      // Translators may hold a valid finish (e.g. Chat length) until their
      // end-of-stream flush; give them that chance before declaring failure.
      if (!terminalState.terminal && translated && !(sameFormat && clientFormat === FORMATS.OPENAI_RESPONSES)
        && !(providerFormat === FORMATS.CLAUDE && !upstreamClaudeMessageStopped)) {
        emitTranslation(null, controller);
        if (terminalState.terminal && !terminalState.doneSent && clientFormat !== FORMATS.CLAUDE) { done(controller); finalize(); }
        if (terminalState.terminal) return;
      }
      if (!terminalState.terminal) fail(controller);
      else { done(controller); finalize(); }
      return;
    }
    if (providerFormat === FORMATS.OPENAI_RESPONSES && frame.event && input.type && frame.event !== input.type) {
      fail(controller, "Upstream SSE event type mismatch");
      return;
    }
    if (providerFormat === FORMATS.CLAUDE) {
      if (input.type === "message_delta" && input.delta?.stop_reason) upstreamClaudeStop = true;
      if (input.type === "message_stop" && upstreamClaudeStop) upstreamClaudeMessageStopped = true;
      if (input.type === "message_stop" && !upstreamClaudeStop) {
        fail(controller, "Upstream Claude stream lacked a stop reason");
        return;
      }
      if (input.type === "error") {
        fail(controller, "Upstream Claude stream failed");
        return;
      }
    }
    accumulate(input);
    const extracted = extractUsage(input);
    if (extracted) {
      usage = mergeUsage(usage, extracted);
      if (state) state.usage = mergeUsage(state.usage, extracted);
    }
    if (translated && sameFormat && clientFormat === FORMATS.OPENAI_RESPONSES) {
      passthrough(input, frame, controller);
    } else if (translated) {
      emitTranslation(input, controller, providerFormat === FORMATS.CLAUDE && input.type === "message_delta");
      if (providerFormat === FORMATS.CLAUDE && input.type === "message_stop") {
        for (const item of pendingClaudeTerminal) outputItem(item, controller);
        pendingClaudeTerminal = [];
      }
      if (providerFormat === FORMATS.OPENAI_RESPONSES && ["response.failed", "response.incomplete", "error"].includes(input.type) && !terminalState.terminal) {
        fail(controller, "Upstream response failed or was incomplete");
      }
    } else passthrough(input, frame, controller);
  }
  function process(frames, controller) {
    for (const frame of frames) {
      if (terminalState.terminal && !waitsForUsageTrailer()) break;
      try { handleFrame(frame, controller); }
      catch { fail(controller, "Invalid upstream SSE frame"); break; }
    }
  }

  const stream = new TransformStream({
    transform(chunk, controller) {
      if (!ttftAt) ttftAt = Date.now();
      reqLogger?.appendProviderChunk?.(chunk);
      if (terminalState.terminal && !waitsForUsageTrailer()) return;
      try { process(parser.push(chunk), controller); }
      catch { fail(controller, "Invalid or oversized upstream SSE frame"); }
    },
    flush(controller) {
      try {
        if (!terminalState.terminal || waitsForUsageTrailer()) process(parser.finish(), controller);
        if (!terminalState.terminal && providerFormat === FORMATS.CLAUDE && !upstreamClaudeMessageStopped) fail(controller);
        if (!terminalState.terminal && translated) emitTranslation(null, controller);
        // Untracked protocols have no terminal evidence to check; EOF is their end.
        if (!terminalState.terminal && !tracksTerminal) { terminalState.finish("completed"); done(controller); }
        if (!terminalState.terminal) fail(controller);
        else if (!terminalState.doneSent && clientFormat !== FORMATS.CLAUDE) done(controller);
      } catch { fail(controller, "Invalid upstream SSE termination"); }
      dbg("SSE", `flush | provider=${provider} | model=${model} | emitted=${emitted} | outcome=${terminalState.outcome}`);
      finalize();
    }
  });
  stream.terminalState = terminalState;
  // A client cancel or an upstream reset/stall errors the pipe, so flush() never
  // runs. Close usage/detail accounting exactly once without writing downstream.
  stream.finalizeTerminated = (pendingAlreadyReleased = false) => {
    if (!terminalState.terminal) terminalState.finish("failed");
    finalize(pendingAlreadyReleased);
  };
  stream.finalizeCancelled = stream.finalizeTerminated;
  stream.isFinalized = () => finished;
  return stream;
}

export function createSSETransformStreamWithLogger(targetFormat, sourceFormat, provider = null, reqLogger = null, toolNameMap = null, model = null, connectionId = null, body = null, onStreamComplete = null, apiKey = null, customToolNames = null, credentials = null, terminalState = null) {
  return createSSEStream({ mode: TRANSLATE, targetFormat, sourceFormat, provider, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey, customToolNames, credentials, ...(terminalState ? { terminalState } : {}) });
}

export function createPassthroughStreamWithLogger(provider = null, reqLogger = null, model = null, connectionId = null, body = null, onStreamComplete = null, apiKey = null, format = null, terminalState = null) {
  return createSSEStream({ mode: "passthrough", provider, reqLogger, model, connectionId, body, onStreamComplete, apiKey, targetFormat: format || PROVIDERS[provider]?.format || FORMATS.OPENAI, sourceFormat: format || PROVIDERS[provider]?.format || FORMATS.OPENAI, ...(terminalState ? { terminalState } : {}) });
}
