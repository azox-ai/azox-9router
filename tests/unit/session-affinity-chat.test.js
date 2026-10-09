// Handler-level affinity behaviour in src/sse/handlers/chat.js: which upstream
// failures fail closed (409) for encrypted_content and which still fall back.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
  handleChatCore: vi.fn(),
  clearPin: vi.fn(),
  affinityLog: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: vi.fn(),
  extractApiKey: vi.fn(() => "client-key"),
  isValidApiKey: vi.fn(async () => true),
}));
vi.mock("@/sse/services/antigravityQuota.js", () => ({
  handleAntigravityQuotaError: vi.fn(), clearAntigravityStrikes: vi.fn(),
}));
vi.mock("@/lib/localDb", () => ({ getSettings: vi.fn(async () => ({ requireApiKey: false })) }));
vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: vi.fn(async () => ({ provider: "codex", model: "gpt-5.5" })),
  getComboModels: vi.fn(async () => null),
}));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: mocks.handleChatCore }));
vi.mock("@/lib/headroom/detect", () => ({ DEFAULT_HEADROOM_URL: "" }));
vi.mock("@/lib/pxpipe/loader.js", () => ({ getTransform: vi.fn() }));
vi.mock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: vi.fn() }));
vi.mock("open-sse/services/combo.js", () => ({
  handleComboChat: vi.fn(), handleFusionChat: vi.fn(), detectRequiredCapabilities: vi.fn(() => new Set()),
}));
vi.mock("open-sse/services/capacityAdapter.js", () => ({
  augmentModelsWithCapacityAdapter: (models) => models,
  withCapacityAdapterStripping: (fn) => fn,
  getActiveAdapterStrategy: vi.fn(),
}));
vi.mock("open-sse/utils/bypassHandler.js", () => ({ handleBypassRequest: vi.fn(() => null) }));
vi.mock("open-sse/translator/formats.js", () => ({ detectFormatByEndpoint: vi.fn(() => null) }));
vi.mock("@/sse/utils/logger.js", () => ({
  debug: vi.fn(), info: vi.fn(), warn: mocks.warn, error: vi.fn(), maskKey: vi.fn(() => "***"),
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  updateProviderCredentials: vi.fn(),
  checkAndRefreshToken: vi.fn(async (_p, c) => c),
}));
vi.mock("open-sse/services/projectId.js", () => ({ getProjectIdForConnection: vi.fn() }));
vi.mock("@/sse/utils/gatewayMonitoring.js", () => ({
  buildGatewayAttemptLog: vi.fn(), emitGatewayAttempt: vi.fn(),
  createGatewayMonitoringContext: vi.fn(() => ({ correlationId: "corr-1" })),
}));
vi.mock("@/sse/services/sessionAffinity.js", async (importOriginal) => ({
  ...(await importOriginal()),
  clearPin: mocks.clearPin,
  affinityLog: mocks.affinityLog,
}));

const { handleChat } = await import("@/sse/handlers/chat.js");
const { getComboModels } = await import("@/sse/services/model.js");
const { getSettings } = await import("@/lib/localDb");

const ENCRYPTED_BODY = {
  model: "cx/gpt-5.5",
  input: [{ type: "reasoning", encrypted_content: "enc-blob" }, { role: "user", content: "next" }],
};

function chatRequest(body, headers = { "x-session-id": "sess-1" }) {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-request-id": "req-1", ...headers },
    body: JSON.stringify(body),
  });
}

const creds = (id, affinity) => ({ connectionId: id, connectionName: id, affinity });
const ok = () => ({ success: true, response: new Response("{}", { status: 200 }) });
const fail = (status) => ({ success: false, status, error: "rate limited", response: new Response("x", { status }) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.clearPin.mockResolvedValue(true);
  mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true });
});

describe("chat handler session affinity", () => {
  it("returns 409 when the pinned (hit) account fails and fallback would switch", async () => {
    mocks.getProviderCredentials.mockResolvedValueOnce(creds("conn-aaaa-1", "hit"));
    mocks.handleChatCore.mockResolvedValueOnce(fail(429));

    const res = await handleChat(chatRequest(ENCRYPTED_BODY));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("session_affinity_unavailable");
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(1);
    expect(mocks.clearPin).toHaveBeenCalledWith(expect.anything(), "conn-aaaa-1");
    expect(mocks.affinityLog).toHaveBeenCalledWith("affinity_unavailable", expect.anything(),
      "conn-aaaa-1", "req-1", "pinned_upstream_429");
  });

  it("falls back normally for an unencrypted request with a newly created pin", async () => {
    mocks.getProviderCredentials
      .mockResolvedValueOnce(creds("conn-aaaa-1", "created"))
      .mockResolvedValueOnce(creds("conn-bbbb-2", "created"));
    mocks.handleChatCore.mockResolvedValueOnce(fail(429)).mockResolvedValueOnce(ok());

    const res = await handleChat(chatRequest({ model: "cx/gpt-5.5", input: "hi" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-9router-connection-id")).toBe("conn-bbb");
    expect(res.headers.get("x-9router-affinity")).toBe("created");
  });

  it("returns 409 when auth reports the existing pin is unavailable", async () => {
    mocks.getProviderCredentials.mockResolvedValueOnce({ affinityUnavailable: true, reason: "pinned account excluded" });
    const res = await handleChat(chatRequest(ENCRYPTED_BODY));
    expect(res.status).toBe(409);
    expect((await res.json()).error.message).toContain("pinned account excluded");
  });

  it("returns 409 before selection when encrypted_content has no session key", async () => {
    const res = await handleChat(chatRequest(ENCRYPTED_BODY, {}));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("session_affinity_unavailable");
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledWith("AFFINITY", expect.stringContaining("without session key"));
  });

  it("returns 409 when encrypted_content has a session key but no pin", async () => {
    mocks.getProviderCredentials.mockResolvedValueOnce({ affinityUnavailable: true, reason: "encrypted_content without an active pin" });
    const res = await handleChat(chatRequest(ENCRYPTED_BODY));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("session_affinity_unavailable");
    expect(mocks.handleChatCore).not.toHaveBeenCalled();
  });

  it("refuses fusion fan-out for encrypted_content", async () => {
    getComboModels.mockResolvedValueOnce(["cx/gpt-5.5", "cx/gpt-5.4"]);
    getSettings.mockResolvedValueOnce({ requireApiKey: false, comboStrategy: "fusion" });
    const res = await handleChat(chatRequest(ENCRYPTED_BODY));
    expect(res.status).toBe(409);
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
    expect(mocks.affinityLog).toHaveBeenCalledWith("affinity_unavailable", null, null, "req-1", "fusion_with_encrypted_content");
  });

  it("passes session key and request id into credential selection and sets headers on hit", async () => {
    mocks.getProviderCredentials.mockResolvedValueOnce(creds("conn-aaaa-1", "hit"));
    mocks.handleChatCore.mockResolvedValueOnce(ok());

    const res = await handleChat(chatRequest({ model: "cx/gpt-5.5", input: "hi" }, { "x-codex-session-id": "cs" }));
    expect(res.headers.get("x-9router-affinity")).toBe("hit");
    expect(mocks.getProviderCredentials).toHaveBeenCalledWith("codex", expect.any(Set), "gpt-5.5",
      expect.objectContaining({ sessionKey: "cs", requestId: "req-1", encryptedContent: false, apiKey: "client-key" }));
  });
});
