// Stream handler with disconnect detection - shared for all providers
import { STREAM_STALL_TIMEOUT_MS } from "../config/runtimeConfig.js";
import { dbg, isDebugEnabled } from "./debugLog.js";
import { createSSEFrameParser, parseSSEFrame } from "./sseFrameParser.js";
import { createStreamTerminalState } from "./streamTerminalState.js";
import { FORMATS } from "../translator/formats.js";

// Get HH:MM:SS timestamp
function getTimeString() {
  return new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/**
 * Create stream controller with abort and disconnect detection
 * @param {object} options
 * @param {function} options.onDisconnect - Callback when client disconnects
 * @param {object} options.log - Logger instance
 * @param {string} options.provider - Provider name
 * @param {string} options.model - Model name
 */
export function createStreamController({ onDisconnect, onError, log, provider, model, reqTag = "" } = {}) {
  const abortController = new AbortController();
  const startTime = Date.now();
  let disconnected = false;
  let abortTimeout = null;

  // Only abnormal terminations are logged; normal completion is covered by "📊 done".
  // isError uses errorLine (always shown, ignores LOG_LEVEL) so failures survive quiet levels.
  const logStream = (symbol, status, isError = false) => {
    const duration = Date.now() - startTime;
    const emit = isError ? log?.errorLine : log?.line;
    if (emit) emit(reqTag, symbol, `${status} · ${provider}/${model} · ${duration}ms`);
    else console.log(`[${getTimeString()}] ${symbol} ${provider}/${model} · ${status} · ${duration}ms`);
  };

  return {
    signal: abortController.signal,
    startTime,

    isConnected: () => !disconnected,

    // Call when client disconnects
    // Returns true when this call ran onDisconnect (which releases pending accounting).
    handleDisconnect: (reason = "client_closed") => {
      if (disconnected) return false;
      disconnected = true;

      // Debug-only: Responses API has no [DONE] sentinel, so codex/droid close the
      // socket on every completed request. "📊 done" is the authoritative outcome line.
      dbg("CTRL", `${provider}/${model} | disconnect=${reason} | dur=${Date.now() - startTime}ms`);

      // A client cancellation cannot receive a terminal event. Abort the fetch
      // immediately so the reader, upstream pipe and watchdog can be released.
      if (abortTimeout) clearTimeout(abortTimeout);
      abortController.abort();
      // Contain caller errors: cancellation must still finalize accounting.
      // chatCore's callback releases pending before any external hook runs.
      try { onDisconnect?.({ reason, duration: Date.now() - startTime }); }
      catch (err) { dbg("CTRL", `onDisconnect threw: ${err?.message}`); }
      return Boolean(onDisconnect);
    },

    // Call when stream completes normally (no line here — "📊 done" is authoritative)
    handleComplete: () => {
      if (disconnected) return;
      disconnected = true;

      if (abortTimeout) {
        clearTimeout(abortTimeout);
        abortTimeout = null;
      }
    },

    // Call on error. Returns true when this call ran onError (pending released).
    handleError: (error) => {
      if (disconnected) return false;
      disconnected = true;

      if (abortTimeout) {
        clearTimeout(abortTimeout);
        abortTimeout = null;
      }

      if (error.name === "AbortError") {
        logStream("⚡", "ABORTED");
        return false;
      }

      logStream("✗", `ERROR: ${error.message}${error.stack ? `\n    ${error.stack}` : ""}`, true);
      try { onError?.(error); }
      catch (err) { dbg("CTRL", `onError threw: ${err?.message}`); }
      return Boolean(onError);
    },

    abort: () => abortController.abort()
  };
}

/**
 * Create transform stream with disconnect detection
 * Wraps existing transform stream and adds abort capability.
 *
 * Stall detection lives in pipeWithDisconnect (tied to upstream byte
 * activity), not here — output of the transform stream may be silent
 * for long periods while raw bytes still flow (e.g. Kiro EventStream
 * binary frames buffering, Claude reasoning streams).
 *
 * @param {function} [onAbortTerminal] - Receives a human-readable abort
 * message and returns terminal SSE bytes to emit downstream.
 */
export function createDisconnectAwareStream(transformStream, streamController, onAbortTerminal = null, terminalState = null, onTerminate = null, isFinalized = null) {
  const reader = transformStream.readable.getReader();
  const writer = transformStream.writable?.getWriter?.();
  // Direct callers can supply an ordinary ReadableStream, without stream.js's
  // state. Observe the *forwarded* frames so resets after a terminal stay quiet.
  const parser = createSSEFrameParser();
  let observed = terminalState || transformStream.terminalState || null;
  let cancelled = false;
  let emittedError = false;

  const observe = (value) => {
    if (terminalState) return; // stream.js already observes these chunks
    for (const frame of parser.push(value)) {
      let parsed;
      try { parsed = parseSSEFrame(frame); } catch { continue; }
      if (!parsed || parsed.done) continue;
      if (!observed) {
        const format = parsed.type?.startsWith("response.") ? FORMATS.OPENAI_RESPONSES
          : parsed.type?.startsWith("message_") ? FORMATS.CLAUDE : FORMATS.OPENAI;
        observed = createStreamTerminalState(format);
      }
      observed.observe(parsed, frame.event, observed.clientFormat);
    }
  };
  const cleanup = () => {
    Promise.resolve(reader.cancel()).catch(() => {});
    Promise.resolve(writer?.abort?.()).catch(() => {});
  };
  const emitFailure = (controller, message = "upstream connection lost") => {
    if (cancelled || emittedError || observed?.terminal || !onAbortTerminal) return;
    emittedError = true;
    const state = observed || createStreamTerminalState(onAbortTerminal.name === "buildAbortedResponsesTerminalBytes" ? FORMATS.OPENAI_RESPONSES : FORMATS.OPENAI);
    // Keep the callback's format and stall-specific status where available, but
    // construct Responses failures from the observed ID and sequence number.
    const bytes = state.clientFormat === FORMATS.OPENAI_RESPONSES
      ? state.failureBytes(502, message)
      : onAbortTerminal(message, state);
    if (bytes) controller.enqueue(bytes);
    if (state.clientFormat !== FORMATS.OPENAI_RESPONSES) state.finish("failed");
  };

  return new ReadableStream({
    async pull(controller) {
      if (cancelled) return;
      try {
        const { done, value } = await reader.read();
        if (cancelled) return;
        if (done) {
          if (!observed?.terminal) emitFailure(controller);
          streamController.handleComplete();
          controller.close();
          return;
        }
        try { observe(value); } catch { /* transform itself enforces its buffer bound */ }
        controller.enqueue(value);
      } catch (error) {
        if (cancelled) return;
        let pendingReleased = false;
        if (!observed?.terminal) {
          pendingReleased = streamController.handleError(error) === true;
          try { emitFailure(controller, error?.message === "stream stall timeout" ? "stream stall timeout" : "upstream connection lost"); }
          catch { /* downstream may have closed; never expose raw transport errors */ }
        } else streamController.handleComplete();
        // A stall watchdog may have released pending before this read failed.
        if (streamController.pendingReleased?.()) pendingReleased = true;
        // An errored transform never runs flush(): close request detail/usage here.
        try { onTerminate?.(pendingReleased); } catch { /* accounting must not break the response */ }
        cleanup();
        try { controller.close(); } catch { /* already closed */ }
      }
    },
    async cancel(reason) {
      if (cancelled) return;
      cancelled = true;
      if (isFinalized?.()) {
        // Accounting already closed on the terminal event (Responses clients
        // close the socket right after it): release the upstream without a
        // second pending decrement via onDisconnect.
        streamController.handleComplete();
        streamController.abort?.();
      } else {
        const pendingReleased = streamController.handleDisconnect(reason || "cancelled") === true
          || streamController.pendingReleased?.() === true;
        try { onTerminate?.(pendingReleased); } catch { /* account finalization cannot write to the closed client */ }
      }
      // Await propagation so the upstream body is released before the client
      // cancellation settles (pipeThrough chains cancel asynchronously).
      await Promise.allSettled([
        Promise.resolve().then(() => reader.cancel(reason)),
        Promise.resolve().then(() => writer?.abort?.(reason)),
      ]);
    }
  });
}

/**
 * Pipe provider response through transform with disconnect detection.
 *
 * Stall watchdog tracks raw upstream byte activity, not transform output.
 * Reasoning models (Claude thinking via Kiro, etc.) can produce zero SSE
 * output for long stretches while partial EventStream frames keep arriving.
 * Measuring stall on the transform output caused false stalls and the
 * "failed to pipe response" error in Next.
 *
 * Any upstream chunk resets the timer. If no bytes arrive for
 * STREAM_STALL_TIMEOUT_MS, abort the underlying fetch via the controller.
 *
 * @param {Response} providerResponse - Response from provider
 * @param {TransformStream} transformStream - Transform stream for SSE
 * @param {object} streamController - Stream controller from createStreamController
 */
export function pipeWithDisconnect(providerResponse, transformStream, streamController, onAbortTerminal = null, stallTimeoutMs = STREAM_STALL_TIMEOUT_MS) {
  let stallTimer = null;
  let chunkCount = 0;
  let totalBytes = 0;
  let lastChunkAt = Date.now();
  let abortMessage = "upstream connection lost";
  let pendingReleased = false;
  const t0 = Date.now();
  const tag = "STREAM";
  const clearStall = () => {
    if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
  };
  const armStall = () => {
    clearStall();
    stallTimer = setTimeout(() => {
      stallTimer = null;
      abortMessage = "stream stall timeout";
      dbg(tag, `STALL TIMEOUT ${stallTimeoutMs}ms | chunks=${chunkCount} | bytes=${totalBytes} | sinceLast=${Date.now() - lastChunkAt}ms`);
      if (transformStream.isFinalized?.()) {
        // Accounting already closed on the terminal event; only release the
        // idle upstream socket, never decrement pending a second time.
        streamController.handleComplete();
      } else if (streamController.handleError?.(new Error("stream stall timeout")) === true) {
        pendingReleased = true;
      }
      streamController.abort?.();
    }, stallTimeoutMs);
  };

  // Wrap controller so every termination path clears the stall timer.
  // Without this, abort/cancel/downstream-error paths leave the timer armed
  // and a stale abort could fire after the request has already ended.
  const wrappedController = {
    signal: streamController.signal,
    startTime: streamController.startTime,
    isConnected: () => streamController.isConnected(),
    pendingReleased: () => pendingReleased,
    handleComplete: () => { dbg(tag, `complete | chunks=${chunkCount} | bytes=${totalBytes} | dur=${Date.now() - t0}ms`); clearStall(); streamController.handleComplete(); },
    // The stall timer can run handleError before pull() sees the abort; remember
    // that it released pending accounting so finalization does not release twice.
    handleError: (e) => { dbg(tag, `error: ${e?.message} | chunks=${chunkCount} | bytes=${totalBytes} | dur=${Date.now() - t0}ms`); clearStall(); if (streamController.handleError(e) === true) pendingReleased = true; return pendingReleased; },
    handleDisconnect: (r) => { dbg(tag, `disconnect: ${r} | chunks=${chunkCount} | bytes=${totalBytes} | dur=${Date.now() - t0}ms`); clearStall(); if (streamController.handleDisconnect(r) === true) pendingReleased = true; return pendingReleased; },
    abort: () => { clearStall(); streamController.abort(); }
  };

  armStall();
  dbg(tag, `pipe start | stallTimeout=${stallTimeoutMs}ms`);

  const upstreamTap = new TransformStream({
    transform(chunk, controller) {
      chunkCount++;
      const sz = chunk?.byteLength || chunk?.length || 0;
      totalBytes += sz;
      const now = Date.now();
      const gap = now - lastChunkAt;
      lastChunkAt = now;
      if (isDebugEnabled && (chunkCount <= 5 || chunkCount % 20 === 0 || gap > 5000)) {
        dbg(tag, `chunk #${chunkCount} | size=${sz}B | gap=${gap}ms | total=${totalBytes}B`);
      }
      armStall();
      controller.enqueue(chunk);
    },
    flush() { dbg(tag, `upstream EOF | chunks=${chunkCount} | bytes=${totalBytes} | dur=${Date.now() - t0}ms`); clearStall(); }
  });

  const transformedBody = providerResponse.body
    .pipeThrough(upstreamTap)
    .pipeThrough(transformStream);

  return createDisconnectAwareStream(
    { readable: transformedBody, writable: { getWriter: () => ({ abort: () => Promise.resolve() }) } },
    wrappedController,
    onAbortTerminal ? (message, state) => onAbortTerminal(abortMessage === "stream stall timeout" ? abortMessage : message, state) : null,
    transformStream.terminalState,
    transformStream.finalizeTerminated,
    transformStream.isFinalized
  );
}

