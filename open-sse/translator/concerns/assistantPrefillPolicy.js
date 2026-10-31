import { CLAUDE_BLOCK, ROLE } from "../schema/index.js";
import { isValidClaudeSignature } from "../../utils/claudeSignature.js";

const PRESERVE_HEADER = "x-9router-assistant-prefill";
const CONTINUATION = "Continue from the assistant response above without repeating it.";
const INCOMPLETE_TOOL_RESULT = "Tool execution was not completed before this request continued.";

export function applyAssistantPrefillPolicy(body, rawHeaders = null) {
  if (!Array.isArray(body?.messages)) return body;
  const header = typeof rawHeaders?.get === "function"
    ? rawHeaders.get(PRESERVE_HEADER)
    : Object.entries(rawHeaders || {}).find(([key]) => key.toLowerCase() === PRESERVE_HEADER)?.[1];
  if (String(Array.isArray(header) ? header[0] : header).toLowerCase() === "preserve") return body;

  while (body.messages.at(-1)?.role === ROLE.ASSISTANT) {
    const content = body.messages.at(-1).content;
    const blocks = Array.isArray(content) ? content : [];
    const tools = blocks.filter(b => b?.type === CLAUDE_BLOCK.TOOL_USE && b.id);
    if (tools.length) {
      body.messages.push({ role: ROLE.USER, content: tools.map(tool => ({
        type: CLAUDE_BLOCK.TOOL_RESULT, tool_use_id: tool.id,
        is_error: true, content: INCOMPLETE_TOOL_RESULT,
      })) });
      return body;
    }
    const hasHistory = typeof content === "string" ? !!content.trim() : blocks.some(b =>
      (b?.type === CLAUDE_BLOCK.TEXT && b.text?.trim()) ||
      b?.type === CLAUDE_BLOCK.REDACTED_THINKING ||
      (b?.type === CLAUDE_BLOCK.THINKING && isValidClaudeSignature(b.signature)) ||
      (b?.type === CLAUDE_BLOCK.SERVER_TOOL_USE && b.id));
    if (hasHistory) break;
    body.messages.pop();
  }
  if (!body.messages.length || body.messages.at(-1)?.role === ROLE.ASSISTANT) {
    body.messages.push({ role: ROLE.USER, content: [{ type: CLAUDE_BLOCK.TEXT, text: CONTINUATION }] });
  }
  return body;
}
