import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  createProviderConnection: vi.fn(),
  updateProviderConnection: vi.fn(),
  deleteProviderConnection: vi.fn(),
}));

vi.mock("@/models", () => mocks);
vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init) => Response.json(body, init),
  },
}));

const { PUT, GET, DELETE } = await import("../../src/app/api/internal/portal/connections/[externalId]/route.js");

function request(method, body, token = "service-secret") {
  return new Request("http://localhost/api/internal/portal/connections/account-1", {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const context = { params: Promise.resolve({ externalId: "account-1" }) };

describe("portal connection sync route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PORTAL_SYNC_TOKEN = "service-secret";
    mocks.getProviderConnections.mockResolvedValue([]);
  });

  it("rejects missing or invalid service token", async () => {
    const response = await PUT(request("PUT", { provider: "claude", accessToken: "token", expiresAt: "2030-01-01T00:00:00Z", tokenVersion: 1 }, "wrong"), context);
    expect(response.status).toBe(401);
    expect(mocks.createProviderConnection).not.toHaveBeenCalled();
  });

  it("creates an OAuth connection without refreshToken", async () => {
    mocks.createProviderConnection.mockResolvedValue({ id: "router-id", provider: "claude", isActive: true });

    const response = await PUT(request("PUT", {
      provider: "claude",
      accessToken: "access-token",
      refreshToken: "must-not-pass",
      expiresAt: "2030-01-01T00:00:00Z",
      tokenVersion: 7,
      email: "user@example.com",
      name: "user@example.com",
      displayName: "Sponsored by: anhth2",
    }), context);

    expect(response.status).toBe(200);
    expect(mocks.createProviderConnection).toHaveBeenCalledWith(expect.objectContaining({
      provider: "claude",
      authType: "oauth",
      accessToken: "access-token",
      expiresAt: "2030-01-01T00:00:00.000Z",
      email: "user@example.com",
      name: "user@example.com",
      displayName: "Sponsored by: anhth2",
      providerSpecificData: expect.objectContaining({ portalExternalId: "account-1", portalTokenVersion: 7 }),
    }));
    expect(mocks.createProviderConnection.mock.calls[0][0]).not.toHaveProperty("refreshToken");
  });

  it("updates existing connection and removes stale refreshToken", async () => {
    mocks.getProviderConnections.mockResolvedValue([{
      id: "router-id",
      provider: "codex",
      refreshToken: "old-refresh",
      providerSpecificData: { portalExternalId: "account-1", portalTokenVersion: 2, chatgptAccountId: "acct" },
    }]);
    mocks.updateProviderConnection.mockResolvedValue({ id: "router-id", provider: "codex", isActive: true });

    const response = await PUT(request("PUT", {
      provider: "codex",
      accessToken: "new-access",
      expiresAt: "2030-01-01T00:00:00Z",
      tokenVersion: 3,
    }), context);

    expect(response.status).toBe(200);
    expect(mocks.updateProviderConnection).toHaveBeenCalledWith("router-id", expect.objectContaining({
      accessToken: "new-access",
      refreshToken: undefined,
      providerSpecificData: expect.objectContaining({
        portalExternalId: "account-1",
        portalTokenVersion: 3,
        chatgptAccountId: "acct",
      }),
    }));
  });

  it("rejects stale token versions", async () => {
    mocks.getProviderConnections.mockResolvedValue([{
      id: "router-id",
      provider: "claude",
      providerSpecificData: { portalExternalId: "account-1", portalTokenVersion: 5 },
    }]);

    const response = await PUT(request("PUT", {
      provider: "claude",
      accessToken: "old-access",
      expiresAt: "2030-01-01T00:00:00Z",
      tokenVersion: 4,
    }), context);

    expect(response.status).toBe(409);
    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("treats an equal token version as an idempotent retry", async () => {
    mocks.getProviderConnections.mockResolvedValue([{
      id: "router-id",
      provider: "claude",
      isActive: true,
      expiresAt: "2030-01-01T00:00:00.000Z",
      providerSpecificData: { portalExternalId: "account-1", portalTokenVersion: 5 },
    }]);
    const response = await PUT(request("PUT", {
      provider: "claude", accessToken: "same-version", expiresAt: "2030-01-01T00:00:00Z", tokenVersion: 5,
    }), context);
    expect(response.status).toBe(200);
    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("returns token-safe status and deletes managed connection", async () => {
    mocks.getProviderConnections.mockResolvedValue([{
      id: "router-id",
      provider: "claude",
      accessToken: "secret",
      refreshToken: "secret",
      expiresAt: "2030-01-01T00:00:00.000Z",
      isActive: true,
      providerSpecificData: { portalExternalId: "account-1", portalTokenVersion: 5 },
    }]);
    mocks.deleteProviderConnection.mockResolvedValue(true);

    const status = await GET(request("GET"), context);
    expect(await status.json()).toEqual({
      found: true,
      id: "router-id",
      provider: "claude",
      enabled: true,
      expiresAt: "2030-01-01T00:00:00.000Z",
      tokenVersion: 5,
    });

    const removed = await DELETE(request("DELETE"), context);
    expect(removed.status).toBe(204);
    expect(mocks.deleteProviderConnection).toHaveBeenCalledWith("router-id");
  });
});
