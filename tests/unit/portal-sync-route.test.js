import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  upsertPortalManagedConnection: vi.fn(),
  deleteProviderConnection: vi.fn(),
}));

vi.mock("@/models", () => ({
  getProviderConnections: mocks.getProviderConnections,
  deleteProviderConnection: mocks.deleteProviderConnection,
}));
vi.mock("@/lib/db/index", () => ({ upsertPortalManagedConnection: mocks.upsertPortalManagedConnection }));
vi.mock("next/server", () => ({ NextResponse: { json: (body, init) => Response.json(body, init) } }));

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

const input = { provider: "claude", accessToken: "access-token", expiresAt: "2030-01-01T00:00:00Z", tokenVersion: 7 };
const connection = {
  id: "router-id", provider: "claude", isActive: true,
  expiresAt: "2030-01-01T00:00:00.000Z",
  providerSpecificData: { portalExternalId: "account-1", portalTokenVersion: 7 },
};

describe("portal connection sync route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PORTAL_SYNC_TOKEN = "service-secret";
    mocks.getProviderConnections.mockResolvedValue([]);
    mocks.upsertPortalManagedConnection.mockResolvedValue({ status: "created", connection, tokenVersion: 7 });
  });

  it("rejects missing or invalid service token", async () => {
    const response = await PUT(request("PUT", input, "wrong"), context);
    expect(response.status).toBe(401);
    expect(mocks.upsertPortalManagedConnection).not.toHaveBeenCalled();
  });

  it("commits access-token-only data using a provider-independent portal identity", async () => {
    const response = await PUT(request("PUT", { ...input, refreshToken: "must-not-pass", email: "user@example.com" }), context);
    expect(response.status).toBe(200);
    expect(mocks.upsertPortalManagedConnection).toHaveBeenCalledWith(
      "account-1", 7, "claude", expect.any(Function),
    );
    const buildValues = mocks.upsertPortalManagedConnection.mock.calls[0][3];
    const values = buildValues(null);
    expect(values).toMatchObject({
      provider: "claude", authType: "oauth", accessToken: "access-token", refreshToken: undefined,
      email: "user@example.com",
      providerSpecificData: { portalExternalId: "account-1", portalTokenVersion: 7 },
    });
  });

  it("preserves existing provider metadata but removes stale refresh tokens", async () => {
    mocks.upsertPortalManagedConnection.mockResolvedValueOnce({ status: "updated", connection, tokenVersion: 7 });
    const response = await PUT(request("PUT", input), context);
    const values = mocks.upsertPortalManagedConnection.mock.calls[0][3]({
      providerSpecificData: { portalExternalId: "account-1", portalTokenVersion: 6, chatgptAccountId: "acct" },
      refreshToken: "old-refresh",
    });
    expect(response.status).toBe(200);
    expect(values.refreshToken).toBeUndefined();
    expect(values.providerSpecificData).toMatchObject({ chatgptAccountId: "acct", portalTokenVersion: 7 });
  });

  it("rejects stale and provider-changing CAS outcomes", async () => {
    mocks.upsertPortalManagedConnection.mockResolvedValueOnce({ status: "stale", connection, tokenVersion: 8 });
    expect((await PUT(request("PUT", input), context)).status).toBe(409);
    mocks.upsertPortalManagedConnection.mockResolvedValueOnce({ status: "provider_mismatch", connection, tokenVersion: 8 });
    expect((await PUT(request("PUT", input), context)).status).toBe(409);
  });

  it("returns the winning version on idempotent retries", async () => {
    mocks.upsertPortalManagedConnection.mockResolvedValueOnce({ status: "unchanged", connection, tokenVersion: 7 });
    const response = await PUT(request("PUT", input), context);
    expect(await response.json()).toMatchObject({ id: "router-id", tokenVersion: 7 });
  });

  it("returns token-safe status and deletes managed connection", async () => {
    mocks.getProviderConnections.mockResolvedValue([{
      ...connection, accessToken: "secret", refreshToken: "secret",
    }]);
    mocks.deleteProviderConnection.mockResolvedValue(true);

    const status = await GET(request("GET"), context);
    expect(await status.json()).toEqual({
      found: true, id: "router-id", provider: "claude", enabled: true,
      expiresAt: "2030-01-01T00:00:00.000Z", tokenVersion: 7,
    });
    const removed = await DELETE(request("DELETE"), context);
    expect(removed.status).toBe(204);
    expect(mocks.deleteProviderConnection).toHaveBeenCalledWith("router-id");
  });
});
