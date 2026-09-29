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
    fixture.adapter.exec(`CREATE TABLE kv (
      scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
      PRIMARY KEY (scope, key)
    );`);
  });

  beforeEach(() => {
    fixture.adapter.exec("DELETE FROM providerConnections;");
    fixture.adapter.exec("DELETE FROM kv;");
  });
  afterAll(() => {
    fixture.adapter?.close();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("does not mark a late failed account attempt unavailable after a newer success", async () => {
    const auth = await import("../../src/sse/services/auth.js");
    const connection = await repo.createProviderConnection({
      provider: "claude", authType: "oauth", email: "account@example.test", accessToken: "token",
    });
    const older = auth.beginAccountMutationAttempt(connection.id, "claude-sonnet-5");
    const newer = auth.beginAccountMutationAttempt(connection.id, "claude-sonnet-5");
    auth.recordAccountMutationSuccess(newer);
    auth.endAccountMutationAttempt(newer);
    const result = await auth.markAccountUnavailable(
      connection.id, 429, "quota exhausted", "claude", "claude-sonnet-5", null,
      { mutationAttempt: older },
    );
    auth.endAccountMutationAttempt(older);
    expect(result.superseded).toBe(true);
    expect((await repo.getProviderConnectionById(connection.id)).testStatus).not.toBe("unavailable");
  });

  it("does not persist a revoked OAuth callback after adapter acquisition", async () => {
    let allowed = true;
    const created = await repo.createProviderConnection({
      provider: "claude", authType: "oauth", email: "revoked@example.test", accessToken: "stale",
    }, { shouldCommit: () => allowed = false });
    expect(created).toBeNull();
    expect(await repo.getProviderConnections({ provider: "claude" })).toHaveLength(0);
  });

  it("does not let ordinary connection creation claim a Portal identity", async () => {
    const direct = await repo.createProviderConnection({
      provider: "claude", authType: "apikey", name: "direct-key", apiKey: "dummy",
      providerSpecificData: { portalExternalId: "portal-claimed", portalTokenVersion: 9000 },
    });
    expect(direct.providerSpecificData?.portalExternalId).toBeUndefined();
    const synced = await repo.upsertPortalManagedConnection(
      "portal-claimed", 1, "claude", () => portalValues("portal-claimed", "portal-token", 1),
    );
    expect(synced.status).toBe("created");
  });

  it("keeps Portal ownership when a regular connection update changes metadata", async () => {
    const original = await repo.upsertPortalManagedConnection(
      "portal-owned", 4, "claude", () => portalValues("portal-owned", "portal-token", 4),
    );
    const updated = await repo.updateProviderConnection(original.connection.id, {
      providerSpecificData: { portalExternalId: null, portalTokenVersion: 1, label: "renamed" },
      accessToken: "unauthorized-replacement",
      refreshToken: "router-refresh-token",
    });
    expect(updated.providerSpecificData.portalExternalId).toBe("portal-owned");
    expect(updated.providerSpecificData.portalTokenVersion).toBe(4);
    expect(updated.accessToken).toBe("portal-token");
    expect(updated.refreshToken).toBeUndefined();
    expect(await repo.deletePortalManagedConnection("portal-owned")).toBe(true);
  });

  it("checks a guarded connection update inside its transaction", async () => {
    const connection = await repo.createProviderConnection({
      provider: "claude", authType: "oauth", email: "account@example.test", accessToken: "original",
    });
    let allowed = true;
    const updated = await repo.updateProviderConnection(connection.id, { accessToken: "fresh" }, {
      shouldCommit: () => allowed,
      beforeCommit: () => { allowed = false; },
      afterCommit: () => { throw new Error("must not commit"); },
    });
    expect(updated).toBeNull();
    expect((await repo.getProviderConnectionById(connection.id)).accessToken).toBe("original");
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

  it("clears stale model locks when Portal pushes a newer access token", async () => {
    const created = await repo.upsertPortalManagedConnection(
      "portal-refresh", 1, "codex", () => ({ ...portalValues("portal-refresh", "old-token", 1), provider: "codex" }),
    );
    await repo.updateProviderConnection(created.connection.id, {
      testStatus: "unavailable", errorCode: "rate_limit", lastError: "old error",
      modelLock_codex: new Date(Date.now() + 60_000).toISOString(),
    });
    const replacement = await repo.upsertPortalManagedConnection(
      "portal-refresh", 2, "codex", () => ({ ...portalValues("portal-refresh", "new-token", 2), provider: "codex" }),
    );
    expect(replacement.status).toBe("updated");
    const current = await repo.getProviderConnectionById(created.connection.id);
    expect(current.accessToken).toBe("new-token");
    expect(current.testStatus).toBe("active");
    expect(current.errorCode).toBeNull();
    expect(current.modelLock_codex).toBeNull();
  });

  it("rejects delayed writes after deletion and keeps a new Portal ID usable", async () => {
    const created = await repo.upsertPortalManagedConnection(
      "portal-1", 7, "claude", () => portalValues("portal-1", "old-token", 7),
    );
    expect(await repo.deletePortalManagedConnection("portal-1")).toBe(true);
    expect(await repo.getProviderConnectionById(created.connection.id)).toBeNull();

    for (const version of [7, 8]) {
      const replay = await repo.upsertPortalManagedConnection(
        "portal-1", version, "claude", () => portalValues("portal-1", "replayed-token", version),
      );
      expect(replay.status).toBe("deleted");
    }
    expect(await repo.getProviderConnections({ provider: "claude" })).toHaveLength(0);
    expect(await repo.deletePortalManagedConnection("portal-1")).toBe(false);

    const replacement = await repo.upsertPortalManagedConnection(
      "portal-2", 1, "claude", () => portalValues("portal-2", "new-token", 1),
    );
    expect(replacement.status).toBe("created");
    expect(replacement.connection.accessToken).toBe("new-token");
  });

  it("removes every duplicate row for a deleted Portal identity", async () => {
    await repo.upsertPortalManagedConnection(
      "portal-dup", 1, "claude", () => portalValues("portal-dup", "first", 1),
    );
    const duplicate = await repo.createProviderConnection({
      ...portalValues("portal-dup", "second", 1), email: "other@example.test",
    });
    // Simulate an existing duplicate from an older build, before identity was reserved.
    fixture.adapter.run(`UPDATE providerConnections SET data = ? WHERE id = ?`, [
      JSON.stringify({
        accessToken: "second",
        providerSpecificData: { portalExternalId: "portal-dup", portalTokenVersion: 1 },
      }), duplicate.id,
    ]);
    expect(await repo.deletePortalManagedConnection("portal-dup")).toBe(true);
    expect(await repo.getProviderConnections({ provider: "claude" })).toHaveLength(0);
  });

  it("tombstones an ID even if DELETE beats the first PUT", async () => {
    expect(await repo.deletePortalManagedConnection("portal-early")).toBe(false);
    const replay = await repo.upsertPortalManagedConnection(
      "portal-early", 1, "claude", () => portalValues("portal-early", "late-token", 1),
    );
    expect(replay.status).toBe("deleted");
    expect(await repo.getProviderConnections({ provider: "claude" })).toHaveLength(0);
  });

  it("retains the deletion tombstone across database reopening", async () => {
    await repo.upsertPortalManagedConnection(
      "portal-3", 2, "codex", () => ({ ...portalValues("portal-3", "token", 2), provider: "codex" }),
    );
    expect(await repo.deletePortalManagedConnection("portal-3")).toBe(true);
    fixture.adapter.close();
    fixture.adapter = await createSqlJsAdapter(path.join(tempDir, "fixture.sqlite"));
    const replay = await repo.upsertPortalManagedConnection(
      "portal-3", 3, "codex", () => ({ ...portalValues("portal-3", "replayed", 3), provider: "codex" }),
    );
    expect(replay.status).toBe("deleted");
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
