import { OPENAI_BLOCK } from "../schema/index.js";

// Collapse plain text parts; preserve multimodal arrays and block metadata.
export function collapseTextParts(parts) {
  if (parts.length === 1 && parts[0].type === OPENAI_BLOCK.TEXT) return parts[0].text;
  if (parts.length > 1 && parts.every(part =>
    part.type === OPENAI_BLOCK.TEXT && typeof part.text === "string" &&
    Object.keys(part).every(key => key === "type" || key === "text")
  )) return parts.map(part => part.text).join("\n");
  return parts;
}
