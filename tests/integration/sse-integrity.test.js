import http from "node:http";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { createStreamController } from "../../open-sse/utils/streamHandler.js";
import { handleStreamingResponse } from "../../open-sse/handlers/chatCore/streamingHandler.js";

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}), saveUsageHistory: vi.fn(async () => {}), saveUsageStats: vi.fn(async () => {}),
}));

const frame = (type, extra = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`;
const created = frame("response.created", { response: { id: "resp_http", status: "in_progress" }, sequence_number: 1 });
const delta = frame("response.output_text.delta", { delta: "partial", sequence_number: 2 });
const completed = frame("response.completed", { response: { id: "resp_http", status: "completed" }, sequence_number: 3 });
const servers = [];
async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => {
    server.closeAllConnections();
    server.close(resolve);
  })));
});

async function requestThroughGateway({ upstream, clientFormat = FORMATS.OPENAI_RESPONSES, userAgent = "codex-cli", provider = "codex" }) {
  const upstreamUrl = await listen((_req, res) => upstream(res));
  const success = vi.fn();
  const gatewayUrl = await listen(async (_req, res) => {
    const streamController = createStreamController({ provider, model: "mock", log: { errorLine() {}, line() {} } });
    try {
      const providerResponse = await fetch(upstreamUrl, { signal: streamController.signal });
      const result = await handleStreamingResponse({
        providerResponse, provider, model: "mock", sourceFormat: clientFormat,
        targetFormat: FORMATS.OPENAI_RESPONSES, userAgent, body: { stream: true }, stream: true,
        translatedBody: {}, requestStartTime: Date.now(), streamController,
        onRequestSuccess: success, log: { errorLine() {}, line() {} },
      });
      res.writeHead(result.response.status, Object.fromEntries(result.response.headers));
      if (result.response.body) Readable.fromWeb(result.response.body).on("error", () => res.destroy()).pipe(res);
      else res.end();
    } catch {
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end();
    }
  });
  const response = await fetch(gatewayUrl);
  const text = await response.text();
  return { status: response.status, contentType: response.headers.get("content-type"), events: inspect(text), successCount: success.mock.calls.length };
}
function inspect(text) {
  const events = [];
  for (const raw of text.replaceAll("\r\n", "\n").split("\n\n")) {
    const lines = raw.split("\n");
    const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    if (!data) continue;
    if (data === "[DONE]") { events.push({ type: "DONE" }); continue; }
    try {
      const parsed = JSON.parse(data);
      const type = lines.find(line => line.startsWith("event:"))?.slice(6).trim() || (parsed.error ? "error" : parsed.type || "chunk");
      events.push({ type, id: parsed.response?.id, sequence: parsed.sequence_number, error: Boolean(parsed.error || parsed.response?.error), status: parsed.response?.status, finish: parsed.choices?.[0]?.finish_reason });
    } catch { events.push({ type: "malformed" }); }
  }
  return events;
}
const types = events => events.map(event => event.type);
const terminals = events => events.filter(event => ["response.completed", "response.failed", "response.incomplete", "error"].includes(event.type));

describe("HTTP SSE integrity with fake loopback upstream and gateway", () => {
  for (const ua of ["codex-cli", "droid"]) {
    it(`native Responses ${ua}: premature upstream EOF is structured failure`, async () => {
      const result = await requestThroughGateway({ userAgent: ua, upstream(res) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(created + delta);
      } });
      const failed = terminals(result.events)[0];
      expect({ status: result.status, terminal: types(terminals(result.events)), id: failed?.id, seqIncreases: failed?.sequence > 2, success: result.successCount }).toEqual({ status: 200, terminal: ["response.failed"], id: "resp_http", seqIncreases: true, success: 0 });
    });
  }

  it("upstream socket reset before terminal yields one failure", async () => {
    const result = await requestThroughGateway({ upstream(res) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(created + delta);
      setTimeout(() => res.destroy(), 20);
    } });
    expect({ status: result.status, terminal: types(terminals(result.events)), id: terminals(result.events)[0]?.id }).toEqual({ status: 200, terminal: ["response.failed"], id: "resp_http" });
  });

  it("socket reset after terminal does not append a failure", async () => {
    const result = await requestThroughGateway({ upstream(res) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(created + completed);
      setTimeout(() => res.destroy(), 20);
    } });
    expect({ status: result.status, terminal: types(terminals(result.events)) }).toEqual({ status: 200, terminal: ["response.completed"] });
  });

  it("translated Responses to Chat emits exactly one [DONE]", async () => {
    const result = await requestThroughGateway({ clientFormat: FORMATS.OPENAI, userAgent: "regular", upstream(res) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(created + delta + completed);
    } });
    expect({ status: result.status, done: types(result.events).filter(type => type === "DONE").length, last: result.events.at(-1)?.type, errors: types(result.events).filter(type => type === "error").length }).toEqual({ status: 200, done: 1, last: "DONE", errors: 0 });
  });

  for (const [name, contentType, body] of [
    ["HTML", "text/html", "<html><title>Maintenance</title></html>"],
    ["plain text", "text/plain", "service unavailable"],
  ]) it(`${name} HTTP 200 is rejected as a gateway error`, async () => {
    const result = await requestThroughGateway({ upstream(res) {
      res.writeHead(200, { "content-type": contentType });
      res.end(body);
    } });
    expect({ status: result.status, completed: types(result.events).includes("response.completed"), success: result.successCount }).toEqual({ status: 502, completed: false, success: 0 });
  });

  it("JSON response on stream:true is normalized or rejected, never empty HTTP-200 success", async () => {
    const result = await requestThroughGateway({ upstream(res) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "response", id: "resp_http", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "present" }] }] }));
    } });
    const outcome = types(terminals(result.events));
    expect(result.status === 502 || (result.status === 200 && outcome.length === 1 && outcome[0] === "response.completed")).toBe(true);
  });
});
