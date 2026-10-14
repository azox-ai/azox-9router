import { describe, expect, it } from "vitest";
import {
  prepareCodexWebSearchFallback,
  runCodexWebSearchFallback,
} from "../../open-sse/services/codexWebSearchFallback.js";

const config = { url: "http://search-internal/v1/search", apiKey: "test-search-key", timeoutMs: 1000,
  maxRounds: 3, maxBodyBytes: 1024 * 1024, maxResultBytes: 16000 };
const call = { type: "function_call", id: "fc_search", call_id: "call_search", name: "ninerouter_web_search",
  arguments: '{"query":"OpenAI docs"}' };
const finalItem = { type: "message", id: "msg_final", role: "assistant", status: "completed",
  content: [{ type: "output_text", text: "Found official docs", annotations: [] }] };
const result = { query: "OpenAI docs", results: [{ title: "Docs", url: "https://developers.openai.com/", snippet: "Real result" }] };

function leg(output, status = "completed") {
  const response = { id: "resp_test", object: "response", status, output,
    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } };
  const events = [{ type: "response.created", sequence_number: 0,
    response: { ...response, status: "in_progress", output: [] } }];
  output.forEach((item, index) => {
    events.push({ type: "response.output_item.added", sequence_number: events.length, output_index: index, item });
    if (item.type === "message") events.push({ type: "response.output_text.delta", sequence_number: events.length,
      output_index: index, item_id: item.id, content_index: 0, delta: item.content[0].text });
    events.push({ type: "response.output_item.done", sequence_number: events.length, output_index: index, item });
  });
  events.push({ type: `response.${status}`, sequence_number: events.length, response });
  return { response: new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n",
    { headers: { "Content-Type": "text/event-stream" } }), transformedBody: {} };
}

function plan(overrides = {}) {
  return prepareCodexWebSearchFallback({ input: "Find docs", tools: [{ type: "web_search_preview" }],
    tool_choice: { type: "web_search_preview" }, ...overrides }, config);
}

async function run(options = {}) {
  let legs = 0;
  return runCodexWebSearchFallback({ plan: plan(), config,
    sendLeg: async () => ++legs === 1 ? leg([call]) : leg([finalItem]),
    search: async () => result, ...options });
}

async function frames(output) {
  return (await output.response.text()).split("\n").filter(line => line.startsWith("data:") && !line.includes("[DONE]"))
    .map(line => JSON.parse(line.slice(5)));
}

describe("Codex gateway-owned Web Search", () => {
  it("only converts built-in search when server endpoint is configured", () => {
    const body = { tools: [{ type: "web_search" }] };
    expect(prepareCodexWebSearchFallback(body, { ...config, url: "" })).toBeNull();
    expect(prepareCodexWebSearchFallback({ ...body, tool_choice: "none" }, config)).toBeNull();
    expect(plan({ tools: [{ type: "function", name: "web_search" }, { type: "custom", name: "web_search" }] })).toBeNull();
    const prepared = plan();
    expect(prepared.body.tools[0]).toMatchObject({ type: "function", name: "ninerouter_web_search",
      parameters: { required: ["query"] } });
    expect(prepared.body.tool_choice).toEqual({ type: "function", name: "ninerouter_web_search" });
  });

  it("preserves client tools and avoids name collisions", () => {
    const client = { type: "custom", name: "ninerouter_web_search", format: { type: "text" } };
    const prepared = plan({ tools: [{ type: "web_search" }, client] });
    expect(prepared.toolName).not.toBe(client.name);
    expect(prepared.body.tools).toContainEqual(client);
  });

  it("does not silently enable internet access for a cache-only request", () => {
    expect(() => plan({ tools: [{ type: "web_search", external_web_access: false }] })).toThrow(/external_web_access/);
  });

  it("runs search then resumes original input and encrypted reasoning", async () => {
    const reasoning = { type: "reasoning", encrypted_content: "opaque", summary: [] };
    const history = [{ role: "user", content: "Earlier prompt" }];
    const prepared = plan({ input: history, prompt_cache_key: "stable-session" });
    const bodies = [];
    const searches = [];
    const output = await run({ plan: prepared,
      sendLeg: async body => {
        bodies.push(structuredClone(body));
        return bodies.length === 1 ? leg([reasoning, call]) : leg([finalItem]);
      }, search: async (request, signal) => { searches.push(request); expect(signal.aborted).toBe(false); return result; } });
    expect(searches[0]).toMatchObject({ query: "OpenAI docs" });
    expect(bodies[1].input.slice(0, 3)).toEqual([...history, reasoning, call]);
    expect(bodies[1].input[3]).toMatchObject({ type: "function_call_output", call_id: "call_search" });
    expect(JSON.parse(bodies[1].input[3].output).results[0].snippet).toBe("Real result");
    expect(bodies[1].prompt_cache_key).toBe("stable-session");
    expect(bodies[1].tool_choice).toBe("auto");
    expect(bodies[1].tools).toEqual([]);
    const events = await frames(output);
    expect(events.filter(e => e.type === "response.completed")).toHaveLength(1);
    const final = events.at(-1).response;
    expect(final.output.map(item => item.type)).toEqual(["web_search_call", "message"]);
    expect(final.output[0].action).toMatchObject({ type: "search", query: "OpenAI docs" });
    expect(final.output[0].action.sources[0].url).toBe(result.results[0].url);
    expect(final.usage.total_tokens).toBe(24);
    expect(events.find(e => e.type === "response.output_text.delta").output_index).toBe(1);
    expect(events.map(e => e.sequence_number)).toEqual(events.map((_, index) => index));
    expect(output.response.headers.get("x-9router-web-search-fallback")).toBe("executed");
    expect(history).toEqual([{ role: "user", content: "Earlier prompt" }]);
  });

  it("maps domain and country controls to search API", async () => {
    let request;
    await run({ plan: plan({ tools: [{ type: "web_search", search_context_size: "low",
      filters: { allowed_domains: ["developers.openai.com"] }, user_location: { country: "VN" } }] }),
      search: async value => { request = value; return result; } });
    expect(request).toMatchObject({ country: "VN", max_results: 5,
      filters: { include_domains: ["developers.openai.com"] }, strict_filters: true });
  });

  it.each(["function_call", "custom_tool_call"])("retains final client %s without executing it", async type => {
    const client = { type, id: "client_1", call_id: "client_1", name: "exec", input: "text(1)", arguments: "{}" };
    let calls = 0;
    const output = await run({ sendLeg: async () => ++calls === 1 ? leg([call]) : leg([client]) });
    expect((await frames(output)).at(-1).response.output).toEqual([
      expect.objectContaining({ type: "web_search_call" }), client,
    ]);
  });

  it("does not leak internal calls when client and search tools are mixed", async () => {
    const output = await run({ sendLeg: async () => leg([call, { type: "custom_tool_call", name: "exec", call_id: "client" }]) });
    expect(output.response.status).toBe(502);
    expect(await output.response.text()).not.toContain("opaque");
  });

  it("requires an actual upstream terminal, not EOF or error SSE", async () => {
    let searched = false;
    const output = await run({ sendLeg: async () => ({ response: new Response('data: {"type":"error","error":{"code":"server_error"}}\n\n') }),
      search: async () => { searched = true; return result; } });
    expect(output.response.status).toBe(502);
    expect(searched).toBe(false);
  });

  it("fails closed when query is invalid or search API fails", async () => {
    const invalid = await run({ sendLeg: async () => leg([{ ...call, arguments: "{}" }]), search: async () => { throw new Error("must not call"); } });
    expect(invalid.response.status).toBe(502);
    const failed = await run({ search: async () => { throw new Error("Bearer sensitive-token"); } });
    expect(failed.response.status).toBe(502);
    expect(await failed.response.text()).not.toContain("sensitive-token");
  });

  it("retains provider HTTP errors", async () => {
    const output = await run({ sendLeg: async () => ({ response: new Response("unavailable", { status: 503 }) }) });
    expect(output.response.status).toBe(503);
  });

  it("aborts without searching or resuming", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(run({ signal: controller.signal, sendLeg: async () => { throw new Error("must not call"); } }))
      .rejects.toMatchObject({ name: "AbortError" });
  });
});
