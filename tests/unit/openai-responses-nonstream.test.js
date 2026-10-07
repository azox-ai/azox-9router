import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {})
}));

const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { translateNonStreamingResponse } = await import("../../open-sse/handlers/chatCore/nonStreamingHandler.js");
const { handleForcedSSEToJson, parseSSEToOpenAIResponse } = await import("../../open-sse/handlers/chatCore/sseToJsonHandler.js");
const { convertResponsesStreamToJson } = await import("../../open-sse/transformer/streamToJsonConverter.js");
const { saveRequestDetail } = await import("@/lib/usageDb.js");

// A chat.completion body as returned by a chat-native upstream (e.g. op-ericding)
const CHAT_TOOL_BODY = {
  id: "chatcmpl-abc123",
  object: "chat.completion",
  created: 1700000000,
  model: "cl/claude-haiku-4-5",
  choices: [{
    index: 0,
    message: {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "shell", arguments: "{\"cmd\":\"ls\"}" } }]
    },
    finish_reason: "tool_calls"
  }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
};

describe("non-stream Chat upstream for a Responses-API client (op-ericding bug)", () => {
  it("translates chat.completion tool_calls into Responses function_call output", () => {
    // translateNonStreamingResponse(body, targetFormat=PROVIDER format, sourceFormat=CLIENT format)
    const out = translateNonStreamingResponse(CHAT_TOOL_BODY, FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES);
    expect(out.object).toBe("response");
    expect(out).not.toHaveProperty("choices");
    const fc = (out.output || []).find((o) => o.type === "function_call");
    expect(fc).toBeTruthy();
    expect(fc.call_id).toBe("call_1");
    expect(fc.name).toBe("shell");
    expect(fc.arguments).toBe("{\"cmd\":\"ls\"}");
  });

  it("translates marked Chat tools into Responses custom_tool_call output", () => {
    const customBody = structuredClone(CHAT_TOOL_BODY);
    customBody.choices[0].message.tool_calls[0] = {
      id: "call_exec",
      type: "function",
      function: {
        name: "exec",
        arguments: "{\"input\":\"return await tools.shell({command: 'pwd'});\"}"
      }
    };
    const out = translateNonStreamingResponse(
      customBody,
      FORMATS.OPENAI,
      FORMATS.OPENAI_RESPONSES,
      new Set(["exec"])
    );
    const call = (out.output || []).find((item) => item.type === "custom_tool_call");
    expect(call).toMatchObject({
      call_id: "call_exec",
      name: "exec",
      input: "return await tools.shell({command: 'pwd'});"
    });
    expect(out.output.some((item) => item.type === "function_call")).toBe(false);
  });

  it("keeps chat.completion text content as a Responses message item", () => {
    const body = {
      ...CHAT_TOOL_BODY,
      choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }]
    };
    const out = translateNonStreamingResponse(body, FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES);
    const msg = (out.output || []).find((o) => o.type === "message");
    expect(msg).toBeTruthy();
    expect(msg.content[0].type).toBe("output_text");
    expect(msg.content[0].text).toBe("hello");
  });

  it("leaves chat->chat untouched", () => {
    const out = translateNonStreamingResponse(CHAT_TOOL_BODY, FORMATS.OPENAI, FORMATS.OPENAI);
    expect(out.object).toBe("chat.completion");
    expect(out.choices[0].message.tool_calls[0].function.name).toBe("shell");
  });
});

describe("non-stream Claude upstream for a Responses-API client", () => {
  const claudeBody = {
    id: "msg_claude", type: "message", model: "claude-sonnet-5", stop_reason: "end_turn",
    content: [{ type: "text", text: "OK" }], usage: { input_tokens: 12, output_tokens: 2 }
  };

  it("returns a Responses body rather than the Chat pivot body", () => {
    const out = translateNonStreamingResponse(claudeBody, FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES);
    expect(out).toMatchObject({ object: "response", status: "completed", usage: { input_tokens: 12, output_tokens: 2 } });
    expect(out).not.toHaveProperty("choices");
    expect(out.output[0]).toMatchObject({ type: "message", content: [{ type: "output_text", text: "OK" }] });
  });

  it("maps max_tokens to incomplete instead of an invalid status", () => {
    const out = translateNonStreamingResponse({ ...claudeBody, stop_reason: "max_tokens" }, FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES);
    expect(out).toMatchObject({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } });
  });

  it("keeps a Claude tool_use as a Responses function_call", () => {
    const out = translateNonStreamingResponse({ ...claudeBody, stop_reason: "tool_use", content: [{ type: "tool_use", id: "toolu_1", name: "lookup", input: { city: "Hanoi" } }] }, FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES);
    expect(out).toMatchObject({ status: "completed", output: [{ type: "function_call", call_id: "toolu_1", name: "lookup" }] });
  });
});

describe("forced-SSE JSON path for a Responses-API client behind a chat upstream", () => {
  const sseCtx = (sourceFormat, targetFormat) => {
    const encoder = new TextEncoder();
    const raw = [
      'data: {"id":"chatcmpl-sse","object":"chat.completion.chunk","created":1700000000,"model":"gpt-x","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_9","type":"function","function":{"name":"shell","arguments":""}}]},"finish_reason":null}]}',
      'data: {"id":"chatcmpl-sse","object":"chat.completion.chunk","created":1700000000,"model":"gpt-x","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"cmd\\":\\"pwd\\"}"}}]},"finish_reason":null}]}',
      'data: {"id":"chatcmpl-sse","object":"chat.completion.chunk","created":1700000000,"model":"gpt-x","choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      "data: [DONE]",
      ""
    ].join("\n\n");
    return {
      providerResponse: new Response(new ReadableStream({
        start(controller) { controller.enqueue(encoder.encode(raw)); controller.close(); }
      }), { headers: { "content-type": "text/event-stream" } }),
      sourceFormat,
      targetFormat,
      provider: "op-test-chat",
      model: "gpt-x",
      body: { model: "gpt-x", messages: [] },
      stream: false,
      requestStartTime: Date.now(),
      connectionId: "test-connection",
      clientRawRequest: { endpoint: "/v1/responses" },
      trackDone: vi.fn(),
      appendLog: vi.fn()
    };
  };

  it("parses chat SSE chunks and returns a Responses function_call body", async () => {
    const result = await handleForcedSSEToJson(sseCtx(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI));
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.object).toBe("response");
    const fc = (json.output || []).find((o) => o.type === "function_call");
    expect(fc).toBeTruthy();
    expect(fc.name).toBe("shell");
    expect(fc.arguments).toBe("{\"cmd\":\"pwd\"}");
  });

  it("returns a custom_tool_call for a marked tool", async () => {
    const ctx = sseCtx(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI);
    ctx.customToolNames = new Set(["shell"]);
    const result = await handleForcedSSEToJson(ctx);
    expect(result.success).toBe(true);
    const json = await result.response.json();
    const call = (json.output || []).find((item) => item.type === "custom_tool_call");
    expect(call).toMatchObject({
      call_id: "call_9",
      name: "shell",
      input: "{\"cmd\":\"pwd\"}"
    });
  });

  it("still returns chat.completion for a plain chat client", async () => {
    const result = await handleForcedSSEToJson(sseCtx(FORMATS.OPENAI, FORMATS.OPENAI));
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.object).toBe("chat.completion");
    expect(json.choices[0].message.tool_calls[0].function.name).toBe("shell");
  });
});

function streamedResponse(parts) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    }
  }), { headers: { "content-type": "text/event-stream" } });
}

function forcedContext(parts, targetFormat = FORMATS.OPENAI_RESPONSES, sourceFormat = FORMATS.OPENAI_RESPONSES) {
  return {
    providerResponse: streamedResponse(parts), targetFormat, sourceFormat,
    provider: "op-test-chat", model: "test-model", body: { model: "test-model", messages: [] },
    stream: false, requestStartTime: Date.now(), connectionId: "test-connection",
    clientRawRequest: { endpoint: "/v1/responses" },
    trackDone: vi.fn(), appendLog: vi.fn(), onRequestSuccess: vi.fn()
  };
}

describe("forced streaming terminal integrity", () => {
  const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const message = { type: "message", content: [{ type: "output_text", text: "OK" }] };

  it("uses populated terminal output when no item-done event exists", async () => {
    const ctx = forcedContext([event("response.completed", { response: { status: "completed", output: [message] } })]);
    const result = await handleForcedSSEToJson(ctx);
    expect(result.response.status).toBe(200);
    expect((await result.response.json()).output).toEqual([message]);
  });

  it("preserves ordered item-done output when the terminal output is empty", async () => {
    const reasoning = { type: "reasoning", encrypted_content: "opaque-test-value" };
    const ctx = forcedContext([
      event("response.output_item.done", { output_index: 1, item: message }),
      event("response.output_item.done", { output_index: 0, item: reasoning }),
      event("response.completed", { response: { status: "completed", output: [] } }),
    ]);
    const result = await handleForcedSSEToJson(ctx);
    expect(result.response.status).toBe(200);
    expect((await result.response.json()).output).toEqual([reasoning, message]);
  });

  for (const [type, fields] of [
    ["response.output_text.delta", { delta: "partial" }],
    ["response.function_call_arguments.delta", { delta: "{}" }],
    ["response.custom_tool_call_input.done", { input: "partial" }],
    ["response.output_item.added", { item: { type: "function_call", name: "lookup" } }],
  ]) {
    it(`rejects ${type} without reconstructable output instead of empty success`, async () => {
      const ctx = forcedContext([
        event(type, fields),
        event("response.completed", { response: { status: "completed", output: [] } }),
      ]);
      const result = await handleForcedSSEToJson(ctx);
      expect(result.success).toBe(false);
      expect(result.response.status).toBe(502);
      expect((await result.response.json()).error.type).toBe("server_error");
      expect(ctx.onRequestSuccess).not.toHaveBeenCalled();
      expect(ctx.appendLog).not.toHaveBeenCalledWith(expect.objectContaining({ status: "200 OK" }));
    });
  }

  it("allows a legitimate empty completion with no output evidence", async () => {
    const ctx = forcedContext([event("response.completed", { response: { status: "completed", output: [] } })]);
    const result = await handleForcedSSEToJson(ctx);
    expect(result.response.status).toBe(200);
    expect((await result.response.json()).output).toEqual([]);
  });

  it("rejects Responses EOF without terminal rather than returning in_progress HTTP 200", async () => {
    const ctx = forcedContext(['event: response.created\ndata: {"response":{"id":"r1"}}\n\n']);
    const result = await handleForcedSSEToJson(ctx);
    expect(result.success).toBe(false);
    expect(result.response.status).toBe(502);
    expect((await result.response.json()).error.type).toBe("server_error");
    expect(ctx.onRequestSuccess).not.toHaveBeenCalled();
    expect(ctx.appendLog).not.toHaveBeenCalledWith(expect.objectContaining({ status: "200 OK" }));
  });

  it("returns 502 for an explicit Responses failure with no success callback", async () => {
    const ctx = forcedContext(['event: response.failed\ndata: {"response":{"status":"failed"}}\n\n']);
    const result = await handleForcedSSEToJson(ctx);
    expect(result.response.status).toBe(502);
    expect(ctx.onRequestSuccess).not.toHaveBeenCalled();
  });

  it("preserves incomplete status and details without logging success", async () => {
    const ctx = forcedContext(['event: response.incomplete\r\ndata: {"response":{"id":"r2","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}}}\r\n\r\n']);
    const result = await handleForcedSSEToJson(ctx);
    expect(result.success).toBe(true);
    expect(await result.response.json()).toMatchObject({
      id: "r2", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }
    });
    expect(ctx.onRequestSuccess).not.toHaveBeenCalled();
    expect(ctx.appendLog).toHaveBeenCalledWith(expect.objectContaining({ status: "INCOMPLETE 200" }));
    expect(saveRequestDetail).toHaveBeenCalledWith(expect.objectContaining({ status: "incomplete" }));
  });

  it("does not turn a completed Responses event followed by transport reset into failure", async () => {
    let reads = 0;
    const stream = new ReadableStream({
      pull(controller) {
        if (reads++ === 0) controller.enqueue(new TextEncoder().encode('event: response.completed\ndata: {"response":{"id":"r-ok","status":"completed"}}\n\n'));
        else controller.error(new Error("simulated reset"));
      }
    });
    const json = await convertResponsesStreamToJson(stream);
    expect(json).toMatchObject({ id: "r-ok", status: "completed" });
  });

  it("parses byte-split UTF-8, CRLF, multiline data, and EOF tail", async () => {
    const raw = 'event: response.created\r\ndata: {"response":{"id":"r3"}}\r\n\r\nevent: response.output_item.done\r\ndata: {"output_index":0,\r\ndata: "item":{"type":"message","content":[{"type":"output_text","text":"café"}]}}\r\n\r\nevent: response.completed\r\ndata: {"response":{"usage":{"output_tokens":1}}}';
    const bytes = new TextEncoder().encode(raw);
    const parts = [...bytes].map(byte => new Uint8Array([byte]));
    const json = await convertResponsesStreamToJson(new ReadableStream({
      start(controller) { for (const part of parts) controller.enqueue(part); controller.close(); }
    }));
    expect(json.status).toBe("completed");
    expect(json.output[0].content[0].text).toBe("café");
    expect(json.usage.output_tokens).toBe(1);
  });

  it("rejects malformed and oversized frames without a successful response", async () => {
    for (const raw of ['event: response.completed\ndata: {broken}\n\n', `data: ${"x".repeat(1048577)}\n\n`]) {
      const ctx = forcedContext([raw]);
      const result = await handleForcedSSEToJson(ctx);
      expect(result.response.status).toBe(502);
      expect(ctx.onRequestSuccess).not.toHaveBeenCalled();
    }
  });

  it("keeps completed Chat JSON when upstream resets after finish", async () => {
    let reads = 0;
    const stream = new ReadableStream({
      pull(controller) {
        if (reads++ === 0) controller.enqueue(new TextEncoder().encode('data: {"id":"c-ok","choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n'));
        else controller.error(new Error("simulated reset"));
      }
    });
    const ctx = forcedContext([], FORMATS.OPENAI, FORMATS.OPENAI);
    ctx.providerResponse = new Response(stream, { headers: { "content-type": "text/event-stream" } });
    const result = await handleForcedSSEToJson(ctx);
    expect(result.success).toBe(true);
    expect((await result.response.json()).choices[0].finish_reason).toBe("stop");
  });

  it("rejects Chat EOF and DONE without finish_reason; retains explicit length as incomplete", async () => {
    const partial = 'data: {"id":"c1","choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n';
    for (const raw of [partial, `${partial}data: [DONE]\n\n`]) {
      const ctx = forcedContext([raw], FORMATS.OPENAI, FORMATS.OPENAI);
      const result = await handleForcedSSEToJson(ctx);
      expect(result.response.status).toBe(502);
      expect(ctx.onRequestSuccess).not.toHaveBeenCalled();
    }
    const ctx = forcedContext([`${partial}data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n`], FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES);
    const result = await handleForcedSSEToJson(ctx);
    expect(result.success).toBe(true);
    expect(await result.response.json()).toMatchObject({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } });
    expect(ctx.onRequestSuccess).not.toHaveBeenCalled();
  });

  it("parses multiline Chat data and honors the final finish frame", () => {
    const parsed = parseSSEToOpenAIResponse('data: {"choices":[{"delta":{"content":"ok"},\r\ndata: "finish_reason":"stop"}]}\r\n\r\n', "test-model");
    expect(parsed.choices[0].message.content).toBe("ok");
    expect(parsed.choices[0].finish_reason).toBe("stop");
  });
});
