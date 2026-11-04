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
  beginAccountMutationAttempt: vi.fn(() => ({})),
  endAccountMutationAttempt: vi.fn(),
  recordAccountMutationSuccess: vi.fn(),
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
  augmentModelsWithCapacityAdapter: vi.fn((models) => models),
  withCapacityAdapterStripping: (fn) => fn,
  getActiveAdapterStrategy: vi.fn(),
}));
vi.mock("open-sse/utils/bypassHandler.js", () => ({ handleBypassRequest: vi.fn(() => null) }));
vi.mock("open-sse/translator/formats.js", async (importOriginal) => ({
  ...(await importOriginal()), detectFormatByEndpoint: vi.fn(() => null),
}));
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
const { augmentModelsWithCapacityAdapter } = await import("open-sse/services/capacityAdapter.js");
const { handleComboChat } = await import("open-sse/services/combo.js");

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
  it.each(["hit", "created"])("retains a %s explicit owner after upstream failure", async (affinity) => {
    mocks.getProviderCredentials.mockResolvedValueOnce(creds("conn-aaaa-1", affinity));
    mocks.handleChatCore.mockResolvedValueOnce(fail(429));

    const res = await handleChat(chatRequest({ model: "cx/gpt-5.5", input: "hi" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("session_affinity_unavailable");
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(1);
    expect(mocks.clearPin).not.toHaveBeenCalled();
    expect(mocks.affinityLog).toHaveBeenCalledWith("affinity_unavailable", expect.anything(),
      "conn-aaaa-1", "req-1", "pinned_upstream_429");
  });

  it("returns 409 without clearing a pinned owner when ciphertext fails", async () => {
    mocks.getProviderCredentials.mockResolvedValueOnce(creds("conn-aaaa-1", "hit"));
    mocks.handleChatCore.mockResolvedValueOnce(fail(429));
    const res = await handleChat(chatRequest(ENCRYPTED_BODY));
    expect(res.status).toBe(409);
    expect(mocks.clearPin).not.toHaveBeenCalled();
  });

  it("falls back normally for a sessionless request", async () => {
    mocks.getProviderCredentials
      .mockResolvedValueOnce(creds("conn-aaaa-1"))
      .mockResolvedValueOnce(creds("conn-bbbb-2"));
    mocks.handleChatCore.mockResolvedValueOnce(fail(429)).mockResolvedValueOnce(ok());

    const res = await handleChat(chatRequest({ model: "cx/gpt-5.5", input: "hi" }, {}));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-9router-connection-id")).toBe("conn-bbb");
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(2);
  });

  it("reports temporarily unavailable owner as retryable without switching", async () => {
    mocks.getProviderCredentials.mockResolvedValueOnce({ affinityUnavailable: true, reason: "pinned account excluded", retryable: true });
    const res = await handleChat(chatRequest(ENCRYPTED_BODY));
    expect(res.status).toBe(409);
    const error = (await res.json()).error;
    expect(error.message).toContain("pinned account excluded");
    expect(error.message).toContain("retry the same session");
    expect(error.message).not.toContain("Start a new session");
    expect(mocks.clearPin).not.toHaveBeenCalled();
    expect(mocks.handleChatCore).not.toHaveBeenCalled();
  });

  it("rejects newly created credentials for ciphertext even if selection claims success", async () => {
    mocks.getProviderCredentials.mockResolvedValueOnce(creds("conn-aaaa-1", "created"));
    const res = await handleChat(chatRequest(ENCRYPTED_BODY));
    expect(res.status).toBe(409);
    expect(mocks.handleChatCore).not.toHaveBeenCalled();
  });

  it("returns 409 and retains owner when upstream throws after a claim", async () => {
    mocks.getProviderCredentials.mockResolvedValueOnce(creds("conn-aaaa-1", "created"));
    mocks.handleChatCore.mockRejectedValueOnce(new Error("upstream disconnected"));
    const res = await handleChat(chatRequest({ model: "cx/gpt-5.5", input: "hi" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error.message).toContain("retry the same session");
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(1);
    expect(mocks.clearPin).not.toHaveBeenCalled();
  });

  it("returns 409 without choosing another account if credential selection throws", async () => {
    mocks.getProviderCredentials.mockRejectedValueOnce(new Error("owner storage unavailable"));
    const res = await handleChat(chatRequest({ model: "cx/gpt-5.5", input: "hi" }));
    expect(res.status).toBe(409);
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(1);
    expect(mocks.handleChatCore).not.toHaveBeenCalled();
  });

  it("does not convert a client abort into a session-affinity conflict", async () => {
    mocks.getProviderCredentials.mockResolvedValueOnce(creds("conn-aaaa-1", "hit"));
    mocks.handleChatCore.mockRejectedValueOnce(new DOMException("Aborted", "AbortError"));
    const res = await handleChat(chatRequest({ model: "cx/gpt-5.5", input: "hi" }));
    expect(res.status).toBe(499);
    expect(mocks.clearPin).not.toHaveBeenCalled();
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

  it("requires a pinned owner for ciphertext even when affinity TTL is disabled", async () => {
    vi.stubEnv("NINEROUTER_SESSION_AFFINITY_TTL_MS", "0");
    try {
      const res = await handleChat(chatRequest(ENCRYPTED_BODY, {}));
      expect(res.status).toBe(409);
      expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("disables combo fallback for an explicit plaintext session", async () => {
    getComboModels.mockResolvedValueOnce(["cx/gpt-5.5", "other/model-b"]);
    await handleChat(chatRequest({ model: "combo-model", input: "hi" }));
    expect(handleComboChat).toHaveBeenCalledWith(expect.objectContaining({ allowFallback: false }));
  });

  it("keeps combo fallback for sessionless plaintext requests", async () => {
    getComboModels.mockResolvedValueOnce(["cx/gpt-5.5", "other/model-b"]);
    await handleChat(chatRequest({ model: "combo-model", input: "hi" }, {}));
    expect(handleComboChat).toHaveBeenCalledWith(expect.objectContaining({ allowFallback: true }));
  });

  it("refuses encrypted combo fallback before any provider sees ciphertext", async () => {
    getComboModels.mockResolvedValueOnce(["cx/gpt-5.5", "gemini-cli/gemini-2.5-pro"]);
    const res = await handleChat(chatRequest(ENCRYPTED_BODY));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("session_affinity_unavailable");
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
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

  it("does not switch explicit sessions to a capacity adapter", async () => {
    augmentModelsWithCapacityAdapter.mockReturnValueOnce(["cx/gpt-5.5", "other/vision"]);
    mocks.getProviderCredentials.mockResolvedValueOnce(creds("conn-aaaa-1", "hit"));
    mocks.handleChatCore.mockResolvedValueOnce(ok());
    const res = await handleChat(chatRequest({ model: "cx/gpt-5.5", input: "hi" }));
    expect(res.status).toBe(200);
    expect(handleComboChat).not.toHaveBeenCalled();
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(1);
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
