// Per-request, bounded SSE framing. Never parse a JSON value until its entire
// event (including multi-line data) has arrived. raw preserves provider framing
// for same-format streams that do not need normalization.
const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
const encoder = new TextEncoder();

export function createSSEFrameParser({ ndjson = false, maxBufferBytes = DEFAULT_MAX_FRAME_BYTES } = {}) {
  if (!Number.isSafeInteger(maxBufferBytes) || maxBufferBytes < 1) {
    throw new RangeError("Invalid SSE frame size limit");
  }
  const decoder = new TextDecoder("utf-8");
  let pending = "";
  let raw = "";
  let event = null;
  let data = [];
  let ended = false;

  const checkSize = (text = raw + pending) => {
    if (encoder.encode(text).byteLength > maxBufferBytes) {
      throw new RangeError("Upstream SSE frame exceeds size limit");
    }
  };
  const finishFrame = (frames) => {
    if (raw) frames.push({ event, data: data.length ? data.join("\n") : null, raw });
    raw = "";
    event = null;
    data = [];
  };
  const line = (content, ending, frames) => {
    if (ndjson) {
      if (content.trim()) {
        checkSize(content + ending);
        frames.push({ event: null, data: content, raw: content + ending });
      }
      return;
    }
    raw += content + ending;
    checkSize(raw);
    if (!content) { finishFrame(frames); return; }
    if (content.startsWith(":")) return;
    const colon = content.indexOf(":");
    const field = colon < 0 ? content : content.slice(0, colon);
    const value = colon < 0 ? "" : content.slice(colon + 1).replace(/^ /, "");
    if (field === "data") data.push(value);
    else if (field === "event") event = value;
  };
  const consume = (tail = false) => {
    const frames = [];
    let pos = 0;
    for (let i = 0; i < pending.length; i++) {
      if (pending[i] !== "\n" && pending[i] !== "\r") continue;
      // CRLF may be split across incoming chunks.
      if (!tail && pending[i] === "\r" && i === pending.length - 1) break;
      const ending = pending[i] === "\r" && pending[i + 1] === "\n" ? "\r\n" : pending[i];
      line(pending.slice(pos, i), ending, frames);
      if (ending === "\r\n") i++;
      pos = i + 1;
    }
    pending = pending.slice(pos);
    checkSize();
    if (tail) {
      if (pending) line(pending, "", frames);
      pending = "";
      finishFrame(frames);
    }
    return frames;
  };
  return {
    push(bytes) {
      if (ended) throw new Error("SSE parser already finalized");
      pending += typeof bytes === "string" ? bytes : decoder.decode(bytes, { stream: true });
      return consume();
    },
    finish() {
      if (ended) return [];
      ended = true;
      pending += decoder.decode();
      return consume(true);
    }
  };
}

export function parseSSEFrame(frame) {
  if (frame?.data == null || frame.data === "") return null;
  if (frame.data.trim() === "[DONE]") return { done: true };
  try {
    return JSON.parse(frame.data);
  } catch {
    // Do not leak untrusted provider text, tool arguments or encrypted content.
    throw new SyntaxError("Invalid SSE JSON frame");
  }
}
