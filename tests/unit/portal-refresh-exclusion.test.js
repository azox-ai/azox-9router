// Portal is the sole refresh authority for Portal-managed rows: the request-path
// refresh must never call upstream OAuth or persist credentials for them, even
// when an older build left a stale refresh token on the row.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  latest: vi.fn(), update: vi.fn(), refresh: vi.fn(), executorRefresh: vi.fn(), needsRefresh: vi.fn(),
}));

vi.mock("../../src/lib/localDb.js", () => ({
  getProviderConnectionById: mocks.latest,
  updateProviderConnection: mocks.update,
}));
vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: mocks.latest,
  updateProviderConnection: mocks.update,
}));
vi.mock("open-sse/index.js", () => ({}));
vi.mock("open-sse/services/usage.js", () => ({ getUsageForProvider: vi.fn() }));
vi.mock("open-sse/executors/index.js", () => ({
  getExecutor: () => ({ needsRefresh: mocks.needsRefresh, refreshCredentials: mocks.executorRefresh }),
}));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: vi.fn() }));
vi.mock("open-sse/services/oauthCredentialManager.js", () => ({
  shouldRefreshCredentials: () => true,
  refreshProviderCredentials: mocks.refresh,
}));

const { checkAndRefreshToken } = await import("../../src/sse/services/tokenRefresh.js");
const { refreshAndUpdateCredentials } = await import("../../src/app/api/usage/[connectionId]/route.js");

const expired = "2000-01-01T00:00:00.000Z";

describe("request-path refresh for Portal-managed rows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.latest.mockResolvedValue(null);
    mocks.update.mockResolvedValue({ id: "row" });
    mocks.refresh.mockResolvedValue({ accessToken: "router-minted", refreshToken: "router-rotated", expiresIn: 3600 });
    mocks.needsRefresh.mockReturnValue(true);
    mocks.executorRefresh.mockResolvedValue({ accessToken: "router-minted", refreshToken: "router-rotated", expiresIn: 3600 });
  });

  it.each([undefined, "stale-router-copy"])("does not refresh a Portal row (refreshToken=%s)", async (refreshToken) => {
    const portal = {
      connectionId: "portal-row", authType: "oauth", accessToken: "portal-access", refreshToken,
      expiresAt: expired,
      providerSpecificData: { portalExternalId: "portal-1", portalTokenVersion: 4 },
    };
    const result = await checkAndRefreshToken("codex", portal, { force: true });
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(result.accessToken).toBe("portal-access");
  });

  it("keeps refreshing direct-login OAuth rows", async () => {
    const direct = {
      connectionId: "direct-row", authType: "oauth", accessToken: "old", refreshToken: "direct-refresh",
      expiresAt: expired,
    };
    const result = await checkAndRefreshToken("codex", direct);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledWith("direct-row", expect.objectContaining({
      accessToken: "router-minted", refreshToken: "router-rotated",
    }));
    expect(result.accessToken).toBe("router-minted");
  });

  it("usage route forced refresh leaves a Portal row untouched", async () => {
    const portal = {
      id: "portal-row", provider: "codex", authType: "oauth", accessToken: "portal-access",
      refreshToken: "stale-router-copy", expiresAt: expired,
      providerSpecificData: { portalExternalId: "portal-1", portalTokenVersion: 4 },
    };
    mocks.latest.mockResolvedValue(portal);
    const result = await refreshAndUpdateCredentials(portal, true);
    expect(result).toEqual({ connection: portal, refreshed: false });
    expect(mocks.executorRefresh).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("usage route still refreshes a direct-login OAuth row", async () => {
    const direct = {
      id: "direct-row", provider: "codex", authType: "oauth", accessToken: "old",
      refreshToken: "direct-refresh", expiresAt: expired,
    };
    mocks.latest.mockResolvedValue(direct);
    mocks.update.mockResolvedValue({ ...direct, accessToken: "router-minted" });
    const result = await refreshAndUpdateCredentials(direct, true);
    expect(mocks.executorRefresh).toHaveBeenCalledTimes(1);
    expect(result.refreshed).toBe(true);
  });
});
