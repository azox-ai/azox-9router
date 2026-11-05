import { afterEach, describe, expect, it, vi } from "vitest";
import { GithubExecutor } from "../../open-sse/executors/github.js";
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn() }));
afterEach(() => vi.resetAllMocks());

const encoder = new TextEncoder();
const endpoints = [
  ["Responses", "executeWithResponsesEndpoint", "gpt-5-codex", { type: "response.output_text.delta", delta: "Việt 🌿" }],
  ["Messages", "executeWithMessagesEndpoint", "claude-sonnet-4.6", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Việt 🌿" } }],
];

async function convert(method, model, chunks, stream = true) {
  proxyAwareFetch.mockResolvedValueOnce(new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } }));
  const result = await new GithubExecutor()[method]({
    model, stream, body: { messages: [{ role: "user", content: "Hello" }] }, credentials: {},
  });
  return result.response.text();
}

describe.each(endpoints)("GitHub %s stream EOF", (_name, method, model, textEvent) => {
  it.each(["\n\n", "\n", ""])("preserves explicit SSE terminal with suffix %j", async suffix => {
    expect(await convert(method, model, [`data: [DONE]${suffix}`])).toBe("data: [DONE]\n\n");
  });

  it("preserves a terminal split across transport chunks at EOF", async () => {
    expect(await convert(method, model, ["data: [DO", "NE]"])).toBe("data: [DONE]\n\n");
  });

  it("keeps text before an EOF sentinel and emits the terminal once", async () => {
    const output = await convert(method, model, [`data: ${JSON.stringify(textEvent)}\n\ndata: [DONE]`]);
    expect(output).toContain('"content":"Việt 🌿"');
    expect(output.endsWith("data: [DONE]\n\n")).toBe(true);
    expect(output.match(/data: \[DONE\]/g)).toHaveLength(1);
  });

  it.each(["\n\n", ""])("does not forward sentinel to stream:false with suffix %j", async suffix => {
    expect(await convert(method, model, [`data: [DONE]${suffix}`], false)).toBe("");
  });

  it.each(["\n", ""])("rejects unframed raw JSON with suffix %j", async suffix => {
    expect(await convert(method, model, [JSON.stringify(textEvent) + suffix])).toBe("");
  });

  it.each(["\n\n", ""])("preserves complete UTF-8 content split bytewise with suffix %j", async suffix => {
    const bytes = encoder.encode(`data: ${JSON.stringify(textEvent)}${suffix}`);
    const output = await convert(method, model, Array.from(bytes, byte => Uint8Array.of(byte)));
    const data = output.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
    expect(data.map(chunk => chunk.choices?.[0]?.delta?.content || "").join("")).toBe("Việt 🌿");
    expect(output).not.toContain("�");
    expect(output).not.toContain("[DONE]");
  });
});
