import { ERROR_TYPES, DEFAULT_ERROR_MESSAGES } from "../config/errorConfig.js";

const DEFAULT_UPSTREAM_ERROR_BODY_LIMIT_BYTES = 256 * 1024;
const DEFAULT_UPSTREAM_BODY_STALL_TIMEOUT_MS = 15_000;

export class UpstreamBodyTooLargeError extends Error {
  constructor(maxBytes, actualBytes = null) {
    const detail = Number.isSafeInteger(actualBytes) ? ` (${actualBytes} bytes)` : "";
    super(`Upstream response body exceeds the ${maxBytes}-byte limit${detail}`);
    this.name = "UpstreamBodyTooLargeError";
    this.code = "ERR_UPSTREAM_BODY_TOO_LARGE";
    this.maxBytes = maxBytes;
    this.actualBytes = actualBytes;
  }
}

export class UpstreamBodyStallError extends Error {
  constructor(timeoutMs) {
    super(`Upstream response body stalled for more than ${timeoutMs}ms`);
    this.name = "UpstreamBodyStallError";
    this.code = "ERR_UPSTREAM_BODY_STALLED";
    this.timeoutMs = timeoutMs;
  }
}

export class UpstreamBodyLengthMismatchError extends Error {
  constructor(declaredBytes, actualBytes) {
    super(`Upstream response body length mismatch (declared ${declaredBytes} bytes, received ${actualBytes})`);
    this.name = "UpstreamBodyLengthMismatchError";
    this.code = "ERR_UPSTREAM_BODY_LENGTH_MISMATCH";
    this.declaredBytes = declaredBytes;
    this.actualBytes = actualBytes;
  }
}

function signalReason(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const message = signal?.reason == null ? "Upstream response body aborted" : String(signal.reason);
  return new DOMException(message, "AbortError");
}

function cancelBody(body, reason) {
  try {
    const pending = body?.cancel?.(reason);
    pending?.catch?.(() => {});
  } catch {
    // Best-effort cleanup. Never replace the primary body failure.
  }
}

function declaredBodyLength(response) {
  const raw = response?.headers?.get?.("content-length");
  if (raw == null || !/^\d+$/.test(String(raw).trim())) return null;
  const length = Number(raw);
  return Number.isSafeInteger(length) ? length : Number.POSITIVE_INFINITY;
}

function readBodyChunk(reader, signal, stallTimeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, signalReason(signal));

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
    timer = setTimeout(
      () => finish(reject, new UpstreamBodyStallError(stallTimeoutMs)),
      stallTimeoutMs,
    );
    timer.unref?.();
    let read;
    try {
      read = reader.read();
    } catch (error) {
      finish(reject, error);
      return;
    }
    Promise.resolve(read).then(
      value => finish(resolve, value),
      error => finish(reject, error),
    );
  });
}

/**
 * Consume an upstream response once with a byte cap, per-chunk stall timeout,
 * caller abort propagation, and deterministic reader cleanup. The same signal
 * used for fetch can be kept alive through this read to enforce one full-response
 * deadline instead of protecting only the response headers.
 * Set `fatalUtf8` for success payloads whose protocol requires valid UTF-8;
 * diagnostic error bodies keep replacement decoding so their HTTP status
 * remains authoritative even when the text itself is damaged.
 */
export async function readUpstreamBodyText(
  response,
  {
    signal = null,
    maxBytes = DEFAULT_UPSTREAM_ERROR_BODY_LIMIT_BYTES,
    stallTimeoutMs = DEFAULT_UPSTREAM_BODY_STALL_TIMEOUT_MS,
    fatalUtf8 = false,
  } = {},
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError("maxBytes must be a non-negative safe integer");
  }
  if (!Number.isFinite(stallTimeoutMs) || stallTimeoutMs <= 0) {
    throw new TypeError("stallTimeoutMs must be a positive number");
  }

  const declaredLength = declaredBodyLength(response);
  if (declaredLength !== null && declaredLength > maxBytes) {
    const error = new UpstreamBodyTooLargeError(maxBytes, declaredLength);
    cancelBody(response?.body, error);
    throw error;
  }

  if (signal?.aborted) {
    const error = signalReason(signal);
    cancelBody(response?.body, error);
    throw error;
  }

  const body = response?.body;
  if (!body) return "";
  if (typeof body.getReader !== "function") {
    const error = new TypeError("Upstream response body is not a readable stream");
    cancelBody(body, error);
    throw error;
  }

  const reader = body.getReader();
  const chunks = [];
  let totalBytes = 0;
  let completed = false;
  let terminalError = null;

  try {
    while (true) {
      const { done, value } = await readBodyChunk(reader, signal, stallTimeoutMs);
      if (done) {
        completed = true;
        break;
      }
      if (!(value instanceof Uint8Array)) {
        throw new TypeError("Upstream response body returned an invalid stream chunk");
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        throw new UpstreamBodyTooLargeError(maxBytes, totalBytes);
      }
      if (value.byteLength > 0) chunks.push(value);
    }

    // fetch exposes decoded bytes but commonly retains the compressed wire
    // Content-Length. Only enforce exact framing for identity bodies.
    const contentEncoding = response?.headers?.get?.("content-encoding")?.trim().toLowerCase();
    if (declaredLength !== null && (!contentEncoding || contentEncoding === "identity") &&
        totalBytes !== declaredLength) {
      throw new UpstreamBodyLengthMismatchError(declaredLength, totalBytes);
    }

    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder("utf-8", { fatal: fatalUtf8 }).decode(bytes);
  } catch (error) {
    terminalError = error;
    throw error;
  } finally {
    let cancellation = null;
    if (!completed) {
      try {
        cancellation = Promise.resolve(reader.cancel(terminalError)).catch(() => {});
      } catch {
        // Preserve the primary timeout, abort, transport, or size failure.
      }
    }
    const release = () => {
      try { reader.releaseLock(); } catch { /* pending read or already released */ }
    };
    release();
    cancellation?.finally(release);
  }
}

/**
 * Build OpenAI-compatible error response body
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @returns {object} Error response object
 */
export function buildErrorBody(statusCode, message) {
  const errorInfo = ERROR_TYPES[statusCode] || 
    (statusCode >= 500 
      ? { type: "server_error", code: "internal_server_error" }
      : { type: "invalid_request_error", code: "" });

  return {
    error: {
      message: message || DEFAULT_ERROR_MESSAGES[statusCode] || "An error occurred",
      type: errorInfo.type,
      code: errorInfo.code
    }
  };
}

/**
 * Create error Response object (for non-streaming)
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @returns {Response} HTTP Response object
 */
export function errorResponse(statusCode, message, extraHeaders = null) {
  return new Response(JSON.stringify(buildErrorBody(statusCode, message)), {
    status: statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      ...extraHeaders
    }
  });
}

/**
 * Write error to SSE stream (for streaming)
 * @param {WritableStreamDefaultWriter} writer - Stream writer
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 */
export async function writeStreamError(writer, statusCode, message) {
  const errorBody = buildErrorBody(statusCode, message);
  const encoder = new TextEncoder();
  await writer.write(encoder.encode(`data: ${JSON.stringify(errorBody)}\n\n`));
}

/**
 * Parse upstream provider error response
 * @param {Response} response - Fetch response from provider
 * @param {object} [executor] - Optional executor with parseError() override for provider-specific parsing
 * @param {{signal?: AbortSignal, maxBytes?: number, stallTimeoutMs?: number}} [options]
 * @returns {Promise<{statusCode: number, message: string, resetsAtMs?: number}>}
 */
export async function parseUpstreamError(response, executor = null, options = {}) {
  let bodyText = "";
  try {
    bodyText = await readUpstreamBodyText(response, options);
  } catch (error) {
    // Caller cancellation/full-request deadlines remain authoritative. Size,
    // transport, and local stall failures fall back to the provider status and
    // default message without retaining or reflecting an attacker-sized body.
    if (options.signal?.aborted) throw signalReason(options.signal);
    bodyText = "";
  }

  // Let executor-specific parser extract provider-specific fields (e.g. codex resetsAtMs)
  if (executor && typeof executor.parseError === "function") {
    try {
      const parsed = executor.parseError(response, bodyText);
      if (parsed && typeof parsed === "object") {
        const msg = parsed.message || DEFAULT_ERROR_MESSAGES[response.status] || `Upstream error: ${response.status}`;
        return { statusCode: parsed.status || response.status, message: msg, resetsAtMs: parsed.resetsAtMs };
      }
    } catch { /* fall through to default parsing */ }
  }

  let message = "";
  try {
    const json = JSON.parse(bodyText);
    message = json.error?.message || json.message || json.error || bodyText;
  } catch {
    message = bodyText;
  }

  const messageStr = typeof message === "string" ? message : JSON.stringify(message);
  const finalMessage = messageStr || DEFAULT_ERROR_MESSAGES[response.status] || `Upstream error: ${response.status}`;

  return { statusCode: response.status, message: finalMessage };
}

export const UPSTREAM_ERROR_BODY_LIMIT_BYTES = DEFAULT_UPSTREAM_ERROR_BODY_LIMIT_BYTES;
export const UPSTREAM_BODY_STALL_TIMEOUT_MS = DEFAULT_UPSTREAM_BODY_STALL_TIMEOUT_MS;

/**
 * Create error result for chatCore handler
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @param {number} [resetsAtMs] - Optional precise cooldown expiry (ms epoch) for provider-specific quota errors
 * @returns {{ success: false, status: number, error: string, response: Response, resetsAtMs?: number }}
 */
export function createErrorResult(statusCode, message, resetsAtMs, extraHeaders = null) {
  return {
    success: false,
    status: statusCode,
    error: message,
    resetsAtMs,
    response: errorResponse(statusCode, message, extraHeaders)
  };
}

/**
 * Create unavailable response when all accounts are rate limited
 * @param {number} statusCode - Original error status code
 * @param {string} message - Error message (without retry info)
 * @param {string} retryAfter - ISO timestamp when earliest account becomes available
 * @param {string} retryAfterHuman - Human-readable retry info e.g. "reset after 30s"
 * @returns {Response}
 */
export function unavailableResponse(statusCode, message, retryAfter, retryAfterHuman, extraHeaders = null) {
  const retryAfterSec = Math.max(Math.ceil((new Date(retryAfter).getTime() - Date.now()) / 1000), 1);
  const msg = `${message} (${retryAfterHuman})`;
  return new Response(
    JSON.stringify({ error: { message: msg } }),
    {
      status: statusCode,
      headers: {
        ...extraHeaders,
        "Content-Type": "application/json",
        // Intentionally mis-cased to prevent duplicate headers
        "retry-after": String(retryAfterSec)
      }
    }
  );
}

/**
 * Format provider error with context
 * @param {Error} error - Original error
 * @param {string} provider - Provider name
 * @param {string} model - Model name
 * @param {number|string} statusCode - HTTP status code or error code
 * @returns {string} Formatted error message
 */
export function formatProviderError(error, provider, model, statusCode) {
  const code = statusCode || error.code || "FETCH_FAILED";
  const message = error.message || "Unknown error";
  // Expose low-level cause (e.g. UND_ERR_SOCKET, ECONNRESET, ETIMEDOUT) for diagnosing fetch failures
  const causeCode = error.cause?.code;
  const causeMsg = error.cause?.message;
  const causeStr = causeCode || causeMsg ? ` (cause: ${[causeCode, causeMsg].filter(Boolean).join(": ")})` : "";
  return `[${code}]: ${message}${causeStr}`;
}
