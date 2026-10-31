import { afterEach, describe, expect, it, vi } from "vitest";
import gitlab from "../../src/lib/oauth/providers/gitlab.js";
import xai from "../../src/lib/oauth/providers/xai.js";
import { fetchKiroProfileArn } from "../../src/lib/oauth/providerHelpers.js";
import { QoderService } from "../../src/lib/oauth/services/qoder.js";

const gitlabConfig = {
  defaultBaseUrl: "https://gitlab.example", tokenUrlPath: "/oauth/token",
  userInfoUrlPath: "/api/v4/user", authorizeUrlPath: "/oauth/authorize",
};
const exchangeGitLab = (meta = {}) => gitlab.exchangeToken(
  gitlabConfig, "dummy-code", "https://router.example/callback", "dummy-verifier", "state", meta,
);
const exchangeXai = () => xai.exchangeToken(
  { tokenUrl: "https://auth.example/token", clientId: "test-client" },
  "dummy-code", "https://router.example/callback", "dummy-verifier",
);
const pollQoder = () => new QoderService().pollDeviceToken({ nonce: "test-nonce", codeVerifier: "dummy-verifier" });
const transports = [
  { name: "GitLab", call: exchangeGitLab, limit: 1024 * 1024 },
  { name: "xAI", call: exchangeXai, limit: 256 * 1024 },
  { name: "Qoder", call: pollQoder, limit: 1024 * 1024 },
  { name: "Kiro profile", call: () => fetchKiroProfileArn("dummy-token"), limit: 256 * 1024, nullable: true },
];
const observe = (promise) => promise.then(value => ({ value }), error => ({ error }));
const rejected = (outcome, nullable) => nullable ? outcome.value === null : outcome.error instanceof Error;

function validResponse(name) {
  return Response.json(name === "Kiro profile"
    ? { profiles: [{ arn: "arn:test" }] }
    : name === "Qoder" ? { token: "dummy-token" } : { access_token: "dummy-token" });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe.each(transports)("$name OAuth transport bounds", ({ name, call, limit, nullable }) => {
  it("stops waiting for headers and cancels a late response even when fetch ignores abort", async () => {
    vi.useFakeTimers();
    let deliver;
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => new Promise(resolve => { deliver = resolve; }))
      .mockImplementation(async () => Response.json({}));
    let settled = false;
    const pending = observe(call()).then(result => { settled = true; return result; });
    await vi.advanceTimersByTimeAsync(16_000);
    const stoppedAtDeadline = settled;
    let cancelled = false;
    let close;
    const late = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"access_token":"dummy-token","token":"dummy-token","profiles":[{"arn":"arn:test"}]}'));
        close = () => controller.close();
      },
      cancel() { cancelled = true; },
    }));
    deliver(late);
    await vi.advanceTimersByTimeAsync(0);
    if (!cancelled) close();
    await pending;
    expect(stoppedAtDeadline).toBe(true);
    expect(cancelled).toBe(true);
  });

  it("keeps the deadline active while a response body stalls", async () => {
    vi.useFakeTimers();
    let close;
    let cancelled = false;
    const response = new Response(new ReadableStream({
      start(controller) { close = () => controller.close(); },
      cancel() { cancelled = true; },
    }));
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response)
      .mockImplementation(async () => Response.json({}));
    let settled = false;
    const pending = observe(call()).then(result => { settled = true; return result; });
    await vi.advanceTimersByTimeAsync(16_000);
    const stoppedAtDeadline = settled;
    if (!cancelled) close();
    const result = await pending;
    expect(stoppedAtDeadline).toBe(true);
    expect(cancelled).toBe(true);
    expect(rejected(result, nullable)).toBe(true);
  });

  it("rejects a streamed body over its byte limit without Content-Length", async () => {
    const payload = name === "Kiro profile"
      ? { profiles: [{ arn: "x".repeat(limit + 1) }] }
      : name === "Qoder" ? { token: "x".repeat(limit + 1) } : { access_token: "x".repeat(limit + 1) };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json(payload))
      .mockImplementation(async () => Response.json({}));
    expect(rejected(await observe(call()), nullable)).toBe(true);
  });

  it("rejects malformed UTF-8 instead of accepting a replacement character in credentials", async () => {
    const json = JSON.stringify(name === "Kiro profile"
      ? { profiles: [{ arn: "X" }] } : name === "Qoder" ? { token: "X" } : { access_token: "X" });
    const bytes = new TextEncoder().encode(json);
    bytes[json.indexOf("X")] = 0xff;
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(bytes))
      .mockImplementation(async () => Response.json({}));
    expect(rejected(await observe(call()), nullable)).toBe(true);
  });
});

describe("OAuth provider response safety", () => {
  it.each([
    ["GitLab", exchangeGitLab], ["xAI", exchangeXai],
  ])("%s keeps reflected authorization material out of errors", async (_name, call) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("dummy-reflected-secret", { status: 400 }));
    const result = await observe(call());
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error.message).not.toContain("dummy-reflected-secret");
  });

  it("Kiro profile skips transport when already aborted", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ profiles: [{ arn: "arn:test" }] }));
    const signal = AbortSignal.abort();
    expect(await fetchKiroProfileArn("dummy-token", { signal })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("Kiro profile honors caller cancellation and releases the body", async () => {
    const controller = new AbortController();
    let cancelled = false;
    let close;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new ReadableStream({
      start(c) { close = () => c.close(); }, cancel() { cancelled = true; },
    })));
    let settled = false;
    const pending = fetchKiroProfileArn("dummy-token", { signal: controller.signal })
      .then(value => { settled = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 0));
    controller.abort();
    await new Promise(resolve => setTimeout(resolve, 0));
    const stoppedOnAbort = settled;
    if (!cancelled) close();
    expect(await pending).toBeNull();
    expect(stoppedOnAbort).toBe(true);
    expect(cancelled).toBe(true);
  });

  it.each([[202], [404]])("Qoder cancels pending %s bodies", async status => {
    let cancelled = false;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new ReadableStream({
      cancel() { cancelled = true; },
    }), { status }));
    expect(await pollQoder()).toEqual({ status: "pending" });
    expect(cancelled).toBe(true);
  });

  it.each([[true], [42], [{}], [["token"]], ["   "]])("Qoder rejects a non-token value %j", async token => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ token }));
    await expect(pollQoder()).rejects.toThrow(/no token/);
  });

  it("Qoder keeps valid profile fields when another field has an invalid type", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ name: 42, username: " user ", email: " mail@example.test ", organization_id: {} }));
    expect(await new QoderService().fetchUserInfo("dummy-token"))
      .toEqual({ name: "user", email: "mail@example.test", organizationId: "" });
  });
});

describe("GitLab exact-origin redirect policy", () => {
  it("rejects cross-origin redirects without replaying the authorization body", async () => {
    let cancelled = false;
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new ReadableStream({
      cancel() { cancelled = true; },
    }), { status: 307, headers: { location: "https://other.example/token" } }));
    await expect(exchangeGitLab({ clientSecret: "dummy-secret" })).rejects.toThrow(/origin/);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1].redirect).toBe("manual");
    expect(cancelled).toBe(true);
  });

  it("follows same-origin 307 redirects and preserves the POST body", async () => {
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: "/token2" } }))
      .mockResolvedValueOnce(validResponse("GitLab"))
      .mockResolvedValueOnce(Response.json({ username: "test-user" }));
    expect((await exchangeGitLab())._user.username).toBe("test-user");
    expect(fetch.mock.calls[1][0]).toBe("https://gitlab.example/token2");
    expect(fetch.mock.calls[1][1].method).toBe("POST");
    expect(fetch.mock.calls[1][1].body).toBe(fetch.mock.calls[0][1].body);
  });

  it("follows same-origin 302 redirects as GET without entity headers or body", async () => {
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/token2" } }))
      .mockResolvedValueOnce(validResponse("GitLab"))
      .mockResolvedValueOnce(Response.json({}));
    await exchangeGitLab();
    const init = fetch.mock.calls[1][1];
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(new Headers(init.headers).has("content-type")).toBe(false);
  });

  it("bounds same-origin redirect loops", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(null, { status: 307, headers: { location: "/loop" } }));
    await expect(exchangeGitLab()).rejects.toThrow(/redirect limit/);
    expect(fetch).toHaveBeenCalledTimes(6);
  });

  it.each([
    ["https://user:pass@gitlab.example"], ["https://gitlab.example?token=dummy"], ["https://gitlab.example#fragment"],
  ])("rejects unsafe configured base URL %s before transport", async baseUrl => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ access_token: "dummy-token" }));
    await expect(exchangeGitLab({ baseUrl })).rejects.toThrow(/cannot contain/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
