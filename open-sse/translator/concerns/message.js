import { OPENAI_BLOCK } from "../schema/index.js";

// Collapse plain text parts; preserve cache boundaries and multimodal metadata.
export function collapseTextParts(parts, opts = {}) {
  if (parts.length === 1 && parts[0].type === OPENAI_BLOCK.TEXT
    && !(opts.preserveCacheControl && parts[0].cache_control)) return parts[0].text;
  if (parts.length > 1 && parts.every(part =>
    part.type === OPENAI_BLOCK.TEXT && typeof part.text === "string" &&
    Object.keys(part).every(key => key === "type" || key === "text")
  )) return parts.map(part => part.text).join("\n");
  return parts;
}
