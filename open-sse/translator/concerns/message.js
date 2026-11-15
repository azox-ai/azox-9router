import { OPENAI_BLOCK } from "../schema/index.js";

// Collapse an OpenAI content-part array: a lone text part becomes a plain string,
// otherwise the array is returned as-is. Cache-aware targets retain marked blocks.
export function collapseTextParts(parts, opts = {}) {
  if (parts.length === 1 && parts[0].type === OPENAI_BLOCK.TEXT
    && !(opts.preserveCacheControl && parts[0].cache_control)) return parts[0].text;
  // Claude/OpenAI compatibility needs a text string; Gemini's ordered parts
  // retain their boundaries (including interleaved tool responses).
  if (opts.collapseMultipleText && parts.length > 1 && parts.every(part =>
    part.type === OPENAI_BLOCK.TEXT && typeof part.text === "string" &&
    Object.keys(part).every(key => key === "type" || key === "text")
  )) return parts.map(part => part.text).join("\n");
  return parts;
}
