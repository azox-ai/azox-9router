import { FORMATS } from "../../translator/formats.js";
import { needsTranslation } from "../../translator/index.js";
import { createSSETransformStreamWithLogger, createPassthroughStreamWithLogger } from "../../utils/stream.js";
import { pipeWithDisconnect } from "../../utils/streamHandler.js";
import { PROVIDERS } from "../../config/providers.js";
import { HTTP_STATUS, STREAM_STALL_TIMEOUT_MS } from "../../config/runtimeConfig.js";
import { buildAbortedResponsesTerminalBytes } from "../../utils/responsesStreamHelpers.js";
import { buildStreamErrorBytes, formatSSE } from "../../utils/streamHelpers.js";
import { buildErrorBody } from "../../utils/error.js";
import { buildRequestDetail, extractRequestConfig, saveUsageStats, formatDoneLine } from "./requestDetail.js";
import { saveRequestDetail } from "@/lib/usageDb.js";
import { SSE_HEADERS_CORS as SSE_HEADERS } from "../../utils/sseConstants.js";

// Codex returns Responses API SSE → which client format to translate INTO, by request sourceFormat.
// Gemini-family all map to ANTIGRAVITY decoder; unknown sources fall back to OPENAI.
const CODEX_SOURCE_TO_TARGET = {
  [FORMATS.OPENAI_RESPONSES]: FORMATS.OPENAI_RESPONSES,
  [FORMATS.CLAUDE]: FORMATS.CLAUDE,
  [FORMATS.ANTIGRAVITY]: FORMATS.ANTIGRAVITY,
  [FORMATS.GEMINI]: FORMATS.ANTIGRAVITY,
  [FORMATS.GEMINI_CLI]: FORMATS.ANTIGRAVITY,
};

/**
 * Determine which SSE transform stream to use based on provider/format.
 */
function buildTransformStream({ provider, sourceFormat, targetFormat, reqLogger, toolNameMap, customToolNames, model, connectionId, body, onStreamComplete, apiKey, credentials }) {
  // The provider's actual wire format chooses the transformer. User-Agent is not
  // a protocol signal: codex-cli/droid still need Responses terminal safeguards.
  const isResponsesProvider = PROVIDERS[provider]?.format === FORMATS.OPENAI_RESPONSES;
  if (isResponsesProvider && targetFormat === FORMATS.OPENAI_RESPONSES) {
    const clientFormat = CODEX_SOURCE_TO_TARGET[sourceFormat] || FORMATS.OPENAI;
    return createSSETransformStreamWithLogger(FORMATS.OPENAI_RESPONSES, clientFormat, provider, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey, customToolNames, credentials);
  }
  if (needsTranslation(targetFormat, sourceFormat)) {
    return createSSETransformStreamWithLogger(targetFormat, sourceFormat, provider, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey, customToolNames, credentials);
  }
  return createPassthroughStreamWithLogger(provider, reqLogger, model, connectionId, body, onStreamComplete, apiKey, sourceFormat);
}

function sanitizedUpstreamMessage(text, contentType) {
  const title = text.match(/<title>([^<]+)<\/title>/i)?.[1] || "";
  const clean = (title || (text.length < 200 ? text : "")).replace(/<[^>]*>/g, "").replace(/[\r\n]+/g, " ").trim().slice(0, 160);
  return clean || `Upstream returned non-SSE response (${contentType || "unknown"})`;
}

function errorResult(status, message) {
  return {
    success: false,
    status,
    error: message,
    response: new Response(JSON.stringify(buildErrorBody(status, message)), {
      status,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    }),
  };
}

function jsonError(json) {
  const err = json?.error || (json?.type === "error" ? json.error : null) || (json?.type === "response.failed" ? json.response?.error : null);
  if (!err) return null;
  const upstream = Number(err.status || json?.status);
  return {
    status: Number.isInteger(upstream) && upstream >= 400 && upstream <= 599 ? upstream : HTTP_STATUS.BAD_GATEWAY,
    message: typeof err === "string" ? err : (typeof err.message === "string" ? err.message : "Upstream returned an error"),
  };
}

function jsonToSSE(json, providerFormat, clientFormat, customToolNames) {
  if (providerFormat === FORMATS.OPENAI_RESPONSES && json?.object === "response") {
    const status = json.status === "incomplete" ? "incomplete" : json.status === "completed" ? "completed" : null;
    if (!status) return null;
    if (clientFormat !== FORMATS.OPENAI_RESPONSES) return null;
    const created = { type: "response.created", sequence_number: 0, response: { ...json, status: "in_progress", output: [] } };
    const items = (json.output || []).map((item, index) => ({ type: "response.output_item.done", sequence_number: index + 1, output_index: index, item }));
    const terminal = { type: `response.${status}`, sequence_number: items.length + 1, response: json };
    return [created, ...items, terminal].map(data => formatSSE({ event: data.type, data }, clientFormat)).join("");
  }
  if (providerFormat === FORMATS.OPENAI && json?.object === "chat.completion" && json.choices?.[0]?.finish_reason) {
    if (clientFormat === FORMATS.OPENAI) {
      const choice = json.choices[0];
      const message = choice.message || {};
      const chunk = { id: json.id, object: "chat.completion.chunk", created: json.created, model: json.model, choices: [{ index: 0, delta: { role: "assistant", ...(message.content != null ? { content: message.content } : {}), ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}), ...(message.tool_calls ? { tool_calls: message.tool_calls.map((tc, index) => ({ index, ...tc })) } : {}) }, finish_reason: choice.finish_reason }], ...(json.usage ? { usage: json.usage } : {}) };
      return `${formatSSE(chunk, clientFormat)}data: [DONE]\n\n`;
    }
  }
  return null;
}

async function normalizeJsonForStream({ providerResponse, provider, model, targetFormat, sourceFormat, customToolNames, streamController, log, reqTag }) {
  let json;
  try { json = await providerResponse.json(); }
  catch {
    streamController?.handleError?.(new Error("upstream invalid JSON"));
    return { result: errorResult(HTTP_STATUS.BAD_GATEWAY, "Upstream returned invalid JSON for a streaming request") };
  }
  const upstreamError = jsonError(json);
  if (upstreamError) {
    if (log?.errorLine) log.errorLine(reqTag, "✗", `UPSTREAM JSON ERROR ${upstreamError.status} · ${provider}/${model}`);
    streamController?.handleError?.(new Error("upstream JSON error"));
    return { result: errorResult(upstreamError.status, upstreamError.message) };
  }
  const sse = jsonToSSE(json, targetFormat, sourceFormat, customToolNames);
  if (!sse) {
    streamController?.handleError?.(new Error("unsupported JSON on stream"));
    return { result: errorResult(HTTP_STATUS.BAD_GATEWAY, "Upstream returned JSON that cannot be streamed safely") };
  }
  return { response: new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } }) };
}

/**
 * Handle streaming response — pipe provider SSE through transform stream to client.
 */
export async function handleStreamingResponse({ providerResponse, provider, model, sourceFormat, targetFormat, userAgent, body, stream, translatedBody, finalBody, requestStartTime, connectionId, apiKey, clientRawRequest, onRequestSuccess, reqLogger, toolNameMap, customToolNames, streamController, onStreamComplete, streamDetailId, pxpipe, reqTag, log, credentials }) {
  // A Response with a 2xx status is not a usable stream until its media type is
  // known. HTML/text must be rejected, while a JSON fallback can be converted
  // only when its terminal shape proves success or incompleteness.
  const upstreamContentType = (providerResponse.headers.get("content-type") || "").toLowerCase();
  const providerUsesEmptyContentType = !upstreamContentType && PROVIDERS[provider]?.format === FORMATS.OPENAI_RESPONSES;
  if (!upstreamContentType.includes("text/event-stream") && !providerUsesEmptyContentType && targetFormat !== FORMATS.OLLAMA) {
    if (upstreamContentType.includes("application/json") || upstreamContentType.endsWith("+json")) {
      const normalized = await normalizeJsonForStream({ providerResponse, provider, model, targetFormat, sourceFormat, customToolNames, streamController, log, reqTag });
      if (normalized.result) return normalized.result;
      providerResponse = normalized.response;
    } else {
      const bodyText = await providerResponse.text().catch(() => "");
      const shortMsg = sanitizedUpstreamMessage(bodyText, upstreamContentType);
      if (log?.errorLine) log.errorLine(reqTag, "✗", `BLOCKED 502 · ${provider}/${model} · non-SSE (${upstreamContentType || "missing"})`);
      streamController?.handleError?.(new Error("upstream non-SSE"));
      return errorResult(HTTP_STATUS.BAD_GATEWAY, `[502]: ${shortMsg}`);
    }
  }

  const clientFormat = PROVIDERS[provider]?.format === FORMATS.OPENAI_RESPONSES && targetFormat === FORMATS.OPENAI_RESPONSES
    ? (CODEX_SOURCE_TO_TARGET[sourceFormat] || FORMATS.OPENAI)
    : sourceFormat;
  let successReported = false;
  const reportSuccess = () => {
    if (successReported || !onRequestSuccess) return;
    successReported = true;
    Promise.resolve().then(onRequestSuccess).catch(err => {
      console.error("[ChatCore] onRequestSuccess failed:", err?.message || err);
    });
  };
  const completeWithOutcome = (content, usage, ttftAt, outcome) => {
    if (outcome === "completed") reportSuccess();
    onStreamComplete?.(content, usage, ttftAt, outcome);
  };

  const transformStream = buildTransformStream({ provider, sourceFormat, targetFormat, userAgent, reqLogger, toolNameMap, customToolNames, model, connectionId, body, onStreamComplete: completeWithOutcome, apiKey, credentials });

  // Terminal bytes after HTTP 200 must use the actual client protocol. The state
  // ensures neither EOF/flush nor a later reset can emit a second terminal.
  const onAbortTerminal = (message, state) => state?.failureBytes
    ? state.failureBytes(message === "stream stall timeout" ? HTTP_STATUS.GATEWAY_TIMEOUT : HTTP_STATUS.BAD_GATEWAY, message)
    : (clientFormat === FORMATS.OPENAI_RESPONSES ? buildAbortedResponsesTerminalBytes() : buildStreamErrorBytes(HTTP_STATUS.BAD_GATEWAY, message, clientFormat));
  const stallTimeoutMs = PROVIDERS[provider]?.stallTimeoutMs || STREAM_STALL_TIMEOUT_MS;
  const transformedBody = pipeWithDisconnect(providerResponse, transformStream, streamController, onAbortTerminal, stallTimeoutMs);

  saveRequestDetail(buildRequestDetail({
    provider, model, connectionId,
    latency: { ttft: 0, total: Date.now() - requestStartTime },
    tokens: { prompt_tokens: 0, completion_tokens: 0 },
    request: extractRequestConfig(body, stream),
    providerRequest: finalBody || translatedBody || null,
    providerResponse: "[Streaming - raw response not captured]",
    response: { content: "[Streaming in progress...]", thinking: null, type: "streaming" },
    pxpipe,
    status: "pending"
  }, { id: streamDetailId })).catch(err => {
    console.error("[RequestDetail] Failed to save streaming request:", err.message);
  });

  return {
    success: true,
    response: new Response(transformedBody, { headers: SSE_HEADERS })
  };
}

/**
 * Build onStreamComplete callback for streaming usage tracking.
 */
export function buildOnStreamComplete({ provider, model, connectionId, apiKey, requestStartTime, body, stream, finalBody, translatedBody, clientRawRequest, pxpipe, reqTag, log }) {
  const streamDetailId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

  const onStreamComplete = (contentObj, usage, ttftAt, outcome = "completed") => {
    const latency = {
      ttft: ttftAt ? ttftAt - requestStartTime : Date.now() - requestStartTime,
      total: Date.now() - requestStartTime
    };
    const safeContent = contentObj?.content || "[Empty streaming response]";
    const safeThinking = contentObj?.thinking || null;
    const status = outcome === "completed" ? "success" : outcome === "incomplete" ? "incomplete" : "error";

    saveRequestDetail(buildRequestDetail({
      provider, model, connectionId,
      latency,
      tokens: usage || { prompt_tokens: 0, completion_tokens: 0 },
      request: extractRequestConfig(body, stream),
      providerRequest: finalBody || translatedBody || null,
      providerResponse: safeContent,
      response: { content: safeContent, thinking: safeThinking, type: "streaming", outcome },
      pxpipe,
      status
    }, { id: streamDetailId })).catch(err => {
      console.error("[RequestDetail] Failed to update streaming content:", err.message);
    });

    // Usage is billable even for an interrupted stream; status records the outcome.
    saveUsageStats({ provider, model, tokens: usage, connectionId, apiKey, endpoint: clientRawRequest?.endpoint, label: "STREAM USAGE", silent: true });
    if (outcome === "completed") {
      if (log?.line) log.line(reqTag, "📊", formatDoneLine({ usage, latency }));
    } else if (log?.errorLine) {
      log.errorLine(reqTag, "✗", `STREAM ${outcome.toUpperCase()} · ${provider}/${model} · ${latency.total}ms`);
    }
  };

  return { onStreamComplete, streamDetailId };
}
