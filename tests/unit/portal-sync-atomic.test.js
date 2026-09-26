import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ adapter: null }));
vi.mock("@/lib/db/driver", () => ({ getAdapter: async () => fixture.adapter }));

const { createSqlJsAdapter } = await import("../../src/lib/db/adapters/sqljsAdapter.js");
const repo = await import("../../src/lib/db/repos/connectionsRepo.js");
let tempDir;

function portalValues(externalId, token, version, email = "same@example.test") {
  return {
    provider: "claude", authType: "oauth", email, accessToken: token,
    testStatus: "active", isActive: true, refreshToken: undefined,
    providerSpecificData: { portalExternalId: externalId, portalTokenVersion: version },
  };
}

describe("Portal credential identity and monotonic version", () => {
  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-portal-atomic-"));
    fixture.adapter = await createSqlJsAdapter(path.join(tempDir, "fixture.sqlite"));
    fixture.adapter.exec(`CREATE TABLE providerConnections (
      id TEXT PRIMARY KEY, provider TEXT NOT NULL, authType TEXT NOT NULL,
      name TEXT, email TEXT, priority INTEGER, isActive INTEGER DEFAULT 1,
      data TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
    );`);
  });

  beforeEach(() => fixture.adapter.exec("DELETE FROM providerConnections;"));
  afterAll(() => {
    fixture.adapter?.close();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("never merges Portal accounts with direct-login or other Portal identities", async () => {
    const direct = await repo.createProviderConnection({
      provider: "claude", authType: "oauth", email: "same@example.test",
      accessToken: "direct-access", refreshToken: "direct-refresh", testStatus: "active",
    });
    const first = await repo.upsertPortalManagedConnection(
      "external-1", 1, "claude", () => portalValues("external-1", "portal-one", 1),
    );
    const second = await repo.upsertPortalManagedConnection(
      "external-2", 1, "claude", () => portalValues("external-2", "portal-two", 1),
    );

    expect(first.connection.id).not.toBe(direct.id);
    expect(second.connection.id).not.toBe(first.connection.id);
    expect((await repo.getProviderConnections({ provider: "claude" }))).toHaveLength(3);
    expect(await repo.getProviderConnectionById(direct.id)).toMatchObject({
      accessToken: "direct-access", refreshToken: "direct-refresh",
    });
    expect(first.connection.refreshToken).toBeUndefined();
  });

  it("keeps direct login separate when it arrives after a Portal-managed row", async () => {
    const portal = await repo.upsertPortalManagedConnection(
      "external-1", 1, "claude", () => portalValues("external-1", "portal-access", 1),
    );
    const direct = await repo.createProviderConnection({
      provider: "claude", authType: "oauth", email: "same@example.test",
      accessToken: "direct-access", refreshToken: "direct-refresh", testStatus: "active",
    });

    expect(direct.id).not.toBe(portal.connection.id);
    expect(await repo.getProviderConnectionById(portal.connection.id)).toMatchObject({
      accessToken: "portal-access",
      providerSpecificData: { portalExternalId: "external-1", portalTokenVersion: 1 },
    });
    expect((await repo.getProviderConnections({ provider: "claude" }))).toHaveLength(2);
  });

  it("replays the current Portal version to clear stale health without rotating credentials", async () => {
    const created = await repo.upsertPortalManagedConnection(
      "external-1", 2, "claude", () => portalValues("external-1", "portal-access", 2),
    );
    await repo.updateProviderConnection(created.connection.id, {
      testStatus: "unavailable", errorCode: "no_refresh_token", lastError: "stale failure",
    });
    const replay = await repo.upsertPortalManagedConnection(
      "external-1", 2, "claude", () => portalValues("external-1", "portal-access", 2),
    );

    expect(replay.tokenVersion).toBe(2);
    expect(await repo.getProviderConnectionById(created.connection.id)).toMatchObject({
      accessToken: "portal-access", testStatus: "active", errorCode: null, lastError: null,
      providerSpecificData: { portalExternalId: "external-1", portalTokenVersion: 2 },
    });
  });

  it("rejects stale and equal version updates without changing stored token", async () => {
    await repo.upsertPortalManagedConnection(
      "external-1", 2, "claude", () => portalValues("external-1", "v2", 2),
    );
    const newer = await repo.upsertPortalManagedConnection(
      "external-1", 4, "claude", () => portalValues("external-1", "v4", 4),
    );
    const stale = await repo.upsertPortalManagedConnection(
      "external-1", 3, "claude", () => portalValues("external-1", "v3", 3),
    );
    const replay = await repo.upsertPortalManagedConnection(
      "external-1", 4, "claude", () => portalValues("external-1", "replay", 4),
    );

    expect(stale).toMatchObject({ status: "stale", tokenVersion: 4 });
    expect(replay.status).toBe("unchanged");
    expect(await repo.getProviderConnectionById(newer.connection.id)).toMatchObject({
      accessToken: "v4", providerSpecificData: { portalTokenVersion: 4, portalExternalId: "external-1" },
    });
  });

});
