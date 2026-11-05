import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ adapter: null }));
vi.mock("@/lib/db/driver", () => ({ getAdapter: async () => fixture.adapter }));
const { createSqlJsAdapter } = await import("../../src/lib/db/adapters/sqljsAdapter.js");
const { createProviderConnection } = await import("../../src/lib/db/repos/connectionsRepo.js");
let tempDir;
const values = { provider: "xai", authType: "oauth", email: "dummy@example.test", accessToken: "dummy-token" };
const rows = () => fixture.adapter.all("SELECT * FROM providerConnections ORDER BY id");

// Removing either shouldCommit guard must leave an observable unwanted SQLite write.
describe("ordinary OAuth cancellation at connection commit", () => {
  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "oauth-commit-"));
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

  it("does not insert or change existing priorities when cancelled before the transaction", async () => {
    await createProviderConnection({ ...values, email: "existing@example.test", priority: 7 });
    const before = rows();
    const result = await createProviderConnection(values, { shouldCommit: () => false });
    expect(rows()).toEqual(before);
    expect(result).toBeNull();
  });

  it("rechecks cancellation inside the transaction before inserting", async () => {
    await createProviderConnection({ ...values, email: "existing@example.test", priority: 7 });
    const before = rows();
    let checks = 0;
    const result = await createProviderConnection(values, { shouldCommit: () => ++checks === 1 });
    expect(rows()).toEqual(before);
    expect(checks).toBe(2);
    expect(result).toBeNull();
  });

  it("does not overwrite a deduplicated account when cancelled at the transaction", async () => {
    await createProviderConnection(values);
    const before = rows();
    let checks = 0;
    const result = await createProviderConnection({ ...values, accessToken: "replacement-dummy" }, {
      shouldCommit: () => ++checks === 1,
    });
    expect(rows()).toEqual(before);
    expect(result).toBeNull();
  });

  it("commits a current session, preserving priority allocation and stripping claimed Portal identity", async () => {
    await createProviderConnection({ ...values, email: "existing@example.test", priority: 7 });
    const result = await createProviderConnection({ ...values,
      providerSpecificData: { portalExternalId: "claimed", portalTokenVersion: 9000, label: "direct" },
    }, { shouldCommit: () => true });
    expect(result.priority).toBe(8);
    expect(result.providerSpecificData).toEqual({ label: "direct" });
    expect(rows()).toHaveLength(2);
    expect(rows().some((row) => row.id === result.id)).toBe(true);
  });
});
