import { describe, it, expect } from "vitest";
import { translateRequest } from "../../open-sse/translator/index.js";

import { normalizeClaudePassthrough, anchorClaudeCache } from "../../open-sse/translator/formats/claude.js";

const model = "claude-sonnet-4-5";
const text = (value) => ({ type: "text", text: value });
const native = () => ({ model, messages: [
  { role: "user", content: [text("hi")] },
  { role: "assistant", content: [text("The answer is")] },
] });
function translate(body, source = "claude", headers = {}) {
  return translateRequest(source, "claude", model, body, false, { rawHeaders: headers }, "claude");
}
function markers(body) {
  return [
    ...(Array.isArray(body.system) ? body.system : body.system ? [body.system] : []),
    ...(body.tools || []),
    ...body.messages.flatMap(m => Array.isArray(m.content) ? m.content : []),
  ].filter(block => block.cache_control);
}

describe("AZOX public Claude request contract", () => {
  it("normalizes native passthrough unless preserve was explicitly requested", () => {
    expect(normalizeClaudePassthrough(native(), model).messages.at(-1).role).toBe("user");
    expect(normalizeClaudePassthrough(native(), model, new Headers({ "x-9router-assistant-prefill": "preserve" })).messages.at(-1).role).toBe("assistant");
  });

  it("retains signed reasoning bytes on the prepared request", () => {
    const body = native();
    const block = { type: "thinking", thinking: "Draft", signature: "EnZhbGlkLWNsYXVkZS1zaWduYXR1cmU=" };
    body.messages[1].content = [block];
    const out = translate(body);
    expect(out.messages[1].content).toContainEqual(block);
    expect(out.messages.at(-1).role).toBe("user");
  });

  it("returns missing parallel tool results in call order", () => {
    const body = native();
    body.messages[1].content = ["a", "b"].map(id => ({ type: "tool_use", id, name: "lookup", input: {} }));
    const out = translate(body);
    expect(out.messages.at(-1).role).toBe("user");
    expect(out.messages.at(-1).content.map(b => [b.type, b.tool_use_id, b.is_error])).toEqual([
      ["tool_result", "a", true], ["tool_result", "b", true],
    ]);
  });

  it("strips reasoning markers even when existing markers exhaust the budget", () => {
    const cc = { type: "ephemeral" };
    const out = anchorClaudeCache({ system: [text("s")], tools: [{ name: "lookup", input_schema: {} }], messages: [
      { role: "user", content: [{ ...text("u"), cache_control: cc }] },
      { role: "assistant", content: [
        { ...text("a"), cache_control: cc },
        { type: "thinking", thinking: "Draft", signature: "EnZhbGlkLWNsYXVkZS1zaWduYXR1cmU=", cache_control: cc },
        { type: "redacted_thinking", data: "opaque", cache_control: cc },
      ] },
      { role: "user", content: [text("next")] },
    ] });
    expect(markers(out).length).toBeLessThanOrEqual(4);
    expect(markers(out).some(b => ["thinking", "redacted_thinking"].includes(b.type))).toBe(false);
    expect(out.system.at(-1).cache_control.ttl).toBe("1h");
    expect(out.tools.at(-1).cache_control.ttl).toBe("1h");
  });
  it.each([
    ["claude", native],
    ["gemini", () => ({ contents: [{ role: "user", parts: [{ text: "hi" }] }, { role: "model", parts: [{ text: "The answer is" }] }] })],
    ["openai-responses", () => ({ model, input: [{ role: "user", content: "hi" }, { role: "assistant", content: "The answer is" }] })],
  ])("normalizes default %s prefill to a terminal user without dropping the assistant", (source, input) => {
    const out = translate(input(), source);
    expect(out.messages.map(m => m.role)).toEqual(["user", "assistant", "user"]);
    expect(out.messages[1].content).toEqual(expect.arrayContaining([expect.objectContaining(text("The answer is"))]));
  });

  it("preserves prefill only with an explicit preserve header", () => {
    expect(translate(native(), "claude", { "X-9Router-Assistant-Prefill": "preserve" }).messages.at(-1).role).toBe("assistant");
    expect(translate(native(), "claude", { "x-9router-assistant-prefill": "false" }).messages.at(-1).role).toBe("user");
  });

  it("retains opaque redacted reasoning while adding the user boundary", () => {
    const body = native();
    body.messages[1].content = [{ type: "redacted_thinking", data: "opaque-fixture" }];
    const out = translate(body);
    expect(out.messages.flatMap(m => m.content)).toContainEqual({ type: "redacted_thinking", data: "opaque-fixture" });
    expect(out.messages.at(-1).role).toBe("user");
    expect(markers(out).every(b => !["thinking", "redacted_thinking"].includes(b.type))).toBe(true);
  });

  it.each(["claude", "gemini", "openai-responses"])("preserves explicit %s prefill through translation", source => {
    const body = source === "gemini"
      ? { contents: [{ role: "user", parts: [{ text: "hi" }] }, { role: "model", parts: [{ text: "draft" }] }] }
      : source === "openai-responses"
        ? { input: [{ role: "user", content: "hi" }, { role: "assistant", content: "draft" }] }
        : native();
    expect(translate(body, source, { "x-9router-assistant-prefill": "preserve" }).messages.at(-1).role).toBe("assistant");
  });

  it.each([normalizeClaudePassthrough, body => translate(body)])("preserves reasoning-only history before a later user turn (%#)", prepare => {
    const body = native();
    const reasoning = [
      { type: "thinking", thinking: "Draft", signature: "EnZhbGlkLWNsYXVkZS1zaWduYXR1cmU=" },
      { type: "redacted_thinking", data: "opaque-fixture" },
    ];
    body.messages[1].content = structuredClone(reasoning);
    body.messages.push({ role: "user", content: [text("next")] });
    expect(prepare(body).messages.flatMap(m => m.content)).toEqual(expect.arrayContaining(reasoning));
  });

  it("caches completed tool results after normalization without changing their order", () => {
    const body = native();
    body.system = [text("stable")];
    body.tools = [{ name: "lookup", input_schema: {} }];
    body.messages[1].content = ["a", "b"].map(id => ({ type: "tool_use", id, name: "lookup", input: {} }));
    body.messages.push({ role: "user", content: ["a", "b"].map(id => ({ type: "tool_result", tool_use_id: id, content: id })) });
    const out = translate(body);
    expect(out.messages.at(-1).content.map(b => b.tool_use_id)).toEqual(["a", "b"]);
    expect(out.messages.at(-1).content.at(-1).cache_control).toEqual({ type: "ephemeral" });
    expect(markers(out).length).toBeLessThanOrEqual(4);
  });

  it("caps excessive valid markers and retains eligible head anchors", () => {
    const out = anchorClaudeCache({ system: text("stable"), tools: [{ name: "lookup" }, { name: "later", defer_loading: true }],
      messages: Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: [{ ...text(String(i)), cache_control: { type: "ephemeral" } }] })),
    });
    expect(markers(out)).toHaveLength(4);
    expect(out.system[0].cache_control.ttl).toBe("1h");
    expect(out.tools[0].cache_control.ttl).toBe("1h");
    expect(out.tools[1].cache_control).toBeUndefined();
  });

  it("anchors a single-object system at one hour within the four-marker budget", () => {
    const body = native();
    body.system = text("stable system");
    body.tools = [{ name: "lookup", description: "lookup", input_schema: { type: "object", properties: {} } }];
    const out = translate(body);
    const system = Array.isArray(out.system) ? out.system : [out.system];
    expect(system.find(b => b.text === "stable system").cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(out.tools.at(-1).cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(markers(out).length).toBeLessThanOrEqual(4);
  });
});
