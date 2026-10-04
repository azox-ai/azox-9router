// Non-messages[] sources (Gemini contents[], Responses input[]) carry the client's
// terminal role in their own shape. AZOX defaults to a terminal-user continuation
// for Claude targets; an emptied trailing user turn also gets restored.
import { describe, it, expect } from "vitest";
import { translateRequest } from "../../open-sse/translator/index.js";

const roles = (body) => body.messages.map((m) => m.role);

describe("trailing user turn: non-messages[] source formats", () => {
  it("continues a Gemini trailing model turn for a Claude target", () => {
    const out = translateRequest("gemini", "claude", "claude-sonnet-4-5", {
      contents: [
        { role: "user", parts: [{ text: "hi" }] },
        { role: "model", parts: [{ text: "The answer is" }] },
      ],
    }, false);
    expect(roles(out)).toEqual(["user", "assistant", "user"]);
  });

  it("continues a Responses trailing assistant message for a Claude target", () => {
    const out = translateRequest("openai-responses", "claude", "claude-sonnet-4-5", {
      model: "claude-sonnet-4-5",
      input: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "The answer is" },
      ],
    }, false);
    expect(roles(out)).toEqual(["user", "assistant", "user"]);
  });

  it("still restores a user turn when a Gemini trailing user turn is emptied", () => {
    const out = translateRequest("gemini", "claude", "claude-sonnet-4-5", {
      contents: [
        { role: "user", parts: [{ text: "hi" }] },
        { role: "model", parts: [{ text: "hello" }] },
        { role: "user", parts: [] },
      ],
    }, false);
    expect(roles(out)).toEqual(["user", "assistant", "user"]);
  });
});
