import { OPENAI_BLOCK } from "../schema/index.js";

// Collapse an OpenAI content-part array. A lone text part becomes a plain string
// (cache-aware targets retain a marked block via preserveCacheControl). AZOX also
// joins several metadata-free text parts into one string so OpenAI-compatible
// targets receive string content; callers that must keep separate parts (Gemini
// co-located text around tool results, upstream #2393) pass keepTextParts.
export function collapseTextParts(parts, opts = {}) {
  if (parts.length === 1 && parts[0].type === OPENAI_BLOCK.TEXT
    && !(opts.preserveCacheControl && parts[0].cache_control)) return parts[0].text;
  if (!opts.keepTextParts && parts.length > 1 && parts.every(part =>
    part.type === OPENAI_BLOCK.TEXT && typeof part.text === "string" &&
    Object.keys(part).every(key => key === "type" || key === "text")
  )) return parts.map(part => part.text).join("\n");
  return parts;
}
