import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Run the real modal request-building block; fetch is only a dummy external boundary.
// Restoring GET/private query fields or leaking client secrets must fail these tests.
const source = readFileSync(new URL("../../src/shared/components/OAuthModal.js", import.meta.url), "utf8");
const start = source.indexOf("// Build authorize URL first");
const end = source.indexOf("      setAuthData(", start);
if (start < 0 || end <= start) throw new Error("OAuthModal authorization block not found");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const buildRequests = new AsyncFunction("provider", "oauthMeta", "window", "fetch", "appPort", "redirectUri", source.slice(start, end));

async function requestsFor(provider) {
  const requests = [];
  const fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    const authorize = String(url).includes("/authorize");
    return { ok: true, json: async () => authorize
      ? { state: "dummy-state", codeVerifier: "dummy-verifier", authUrl: "https://example.test/authorize" }
      : { success: true, serverSide: true } };
  };
  await buildRequests(provider, { clientId: "public-client", tenant: "dummy-tenant", clientSecret: "dummy-secret", client_secret: "dummy-snake-secret" },
    { location: { origin: "http://localhost:3000" } }, fetch, "3000",
    provider === "codex" ? "http://localhost:1455/auth/callback" : "http://127.0.0.1:56121/callback");
  return requests;
}

describe.each(["codex", "xai"])("%s modal transport", (provider) => {
  it("sends state and verifier in POST JSON, never in the start-proxy URL", async () => {
    const requests = await requestsFor(provider);
    expect(requests).toHaveLength(2);
    const proxy = requests[1];
    expect(proxy.url).toBe(`/api/oauth/${provider}/start-proxy`);
    expect(proxy.options?.method).toBe("POST");
    expect(proxy.options.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(proxy.options.body)).toEqual({ appPort: "3000", state: "dummy-state", codeVerifier: "dummy-verifier",
      redirectUri: provider === "codex" ? "http://localhost:1455/auth/callback" : "http://127.0.0.1:56121/callback" });
  });

  it("keeps public metadata but removes both client-secret spellings from authorize URLs", async () => {
    const [authorize] = await requestsFor(provider);
    const params = new URL(authorize.url).searchParams;
    expect(params.get("clientId")).toBe("public-client");
    expect(params.get("tenant")).toBe("dummy-tenant");
    expect(params.has("clientSecret")).toBe(false);
    expect(params.has("client_secret")).toBe(false);
    expect(authorize.url).not.toContain("dummy-secret");
    expect(authorize.url).not.toContain("dummy-snake-secret");
  });
});
