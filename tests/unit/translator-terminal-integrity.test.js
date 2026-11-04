import { describe, expect, it } from "vitest";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { initState, translateResponse } from "../../open-sse/translator/index.js";
import { openaiResponsesToOpenAIResponse } from "../../open-sse/translator/response/openai-responses.js";

const chat = (finish_reason = null) => ({
  id: "chatcmpl-unit",
  choices: [{ index: 0, delta: { content: "test" }, finish_reason }]
});
const eventTypes = (events) => events.map(({ event }) => event);

function translateChatStream(finish_reason, target = FORMATS.OPENAI) {
  const state = initState(FORMATS.OPENAI_RESPONSES);
  const events = [
    ...translateResponse(target, FORMATS.OPENAI_RESPONSES,
      target === FORMATS.CLAUDE
        ? { type: "message_start", message: { id: "msg_unit", model: "unit" } }
        : chat(), state),
  ];
  if (target === FORMATS.CLAUDE) {
    events.push(...translateResponse(target, FORMATS.OPENAI_RESPONSES,
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "test" } }, state));
    if (finish_reason) events.push(...translateResponse(target, FORMATS.OPENAI_RESPONSES,
      { type: "message_delta", delta: { stop_reason: finish_reason } }, state));
  } else if (finish_reason) {
    events.push(...translateResponse(target, FORMATS.OPENAI_RESPONSES,
      { id: "chatcmpl-unit", choices: [{ index: 0, delta: {}, finish_reason }] }, state));
  }
  events.push(...translateResponse(target, FORMATS.OPENAI_RESPONSES, null, state));
  return { state, events };
}

describe("Chat to Responses terminal evidence", () => {
  it.each([FORMATS.OPENAI, FORMATS.CLAUDE])("fails a %s stream without finish evidence", (target) => {
    const { events } = translateChatStream(null, target);
    expect(eventTypes(events).filter((name) => name.startsWith("response.") &&
      ["response.failed", "response.completed", "response.incomplete"].includes(name)))
      .toEqual(["response.failed"]);
    expect(events.find(({ event }) => event === "response.failed").data.response.error.code)
      .toBe("missing_finish_reason");
  });

  it.each([[FORMATS.OPENAI, "length"], [FORMATS.OPENAI, "max_tokens"], [FORMATS.CLAUDE, "max_tokens"]])(
    "%s finish %s is incomplete, not completed", (target, reason) => {
      const { events } = translateChatStream(reason, target);
      expect(eventTypes(events)).toContain("response.incomplete");
      expect(eventTypes(events)).not.toContain("response.completed");
      expect(events.find(({ event }) => event === "response.incomplete").data.response.incomplete_details)
        .toEqual({ reason: "max_output_tokens" });
    }
  );

  it.each([[FORMATS.OPENAI, "stop"], [FORMATS.CLAUDE, "end_turn"]])(
    "%s finish %s produces one completion", (target, reason) => {
      const { state, events } = translateChatStream(reason, target);
      expect(eventTypes(events).filter((name) => name === "response.completed")).toHaveLength(1);
      expect(translateResponse(target, FORMATS.OPENAI_RESPONSES, null, state)).toEqual([]);
    }
  );
});

describe("Responses to Chat and Claude failures", () => {
  it.each(["response.failed", "error"])("%s sets an error marker without fake assistant output", (type) => {
    const state = initState(FORMATS.OPENAI);
    const result = openaiResponsesToOpenAIResponse({ type, response: { error: { code: "upstream_failure", message: "failed" } } }, state);
    expect(result).toBeNull();
    expect(state._streamError).toEqual({ code: "upstream_failure", message: "failed" });
    expect(state.finishReasonSent).toBeFalsy();
    expect(openaiResponsesToOpenAIResponse(null, state)).toBeNull();
    expect(state.finishReason).toBeNull();
  });

  const maxOutputIncomplete = [
    ["response.incomplete", { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 3, output_tokens: 2 } } }],
    ["status incomplete", { type: "response.completed", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 3, output_tokens: 2 } } }],
  ];

  it.each(maxOutputIncomplete)("%s max_output_tokens reaches Chat as one length finish", (_label, event) => {
    const state = initState(FORMATS.OPENAI);
    openaiResponsesToOpenAIResponse({ type: "response.output_text.delta", delta: "test" }, state);
    const result = openaiResponsesToOpenAIResponse(event, state);
    expect(result.choices[0].finish_reason).toBe("length");
    expect(result.usage).toEqual({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
    expect(state._streamError).toBeUndefined();
    expect(state.finishReason).toBe("length");
    expect(openaiResponsesToOpenAIResponse(null, state)).toBeNull();
    expect(openaiResponsesToOpenAIResponse(event, state)).toBeNull();
  });

  it.each(maxOutputIncomplete)("%s max_output_tokens reaches Claude as max_tokens", (_label, event) => {
    const state = initState(FORMATS.CLAUDE);
    const out = [
      ...translateResponse(FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, { type: "response.output_text.delta", delta: "test" }, state),
      ...translateResponse(FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, event, state),
      ...translateResponse(FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, null, state),
    ];
    const deltas = out.filter((item) => item.type === "message_delta");
    expect(deltas).toHaveLength(1);
    expect(deltas[0].delta.stop_reason).toBe("max_tokens");
    expect(out.filter((item) => item.type === "message_stop")).toHaveLength(1);
    expect(state._streamError).toBeUndefined();
  });

  it.each([FORMATS.OPENAI, FORMATS.CLAUDE])("%s pivot keeps unrepresentable incomplete an API error", (source) => {
    const state = initState(source);
    const result = translateResponse(FORMATS.OPENAI_RESPONSES, source,
      { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "content_filter" } } }, state);
    expect(result).toEqual([]);
    expect(state._streamError).toEqual({ code: "response_incomplete", message: "Upstream response is incomplete" });
    expect(translateResponse(FORMATS.OPENAI_RESPONSES, source, null, state)).toEqual([]);
    expect(state.finishReason).toBeNull();
  });

  it("does not synthesize stop when a Responses stream ends without completion", () => {
    const state = initState(FORMATS.OPENAI);
    openaiResponsesToOpenAIResponse({ type: "response.output_text.delta", delta: "test" }, state);
    expect(openaiResponsesToOpenAIResponse(null, state)).toBeNull();
    expect(state.finishReason).toBeNull();
  });
});
