import { fork } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ adapter: null }));
vi.mock("@/lib/db/driver.js", () => ({ getAdapter: async () => fixture.adapter }));
vi.mock("@/shared/constants/providers.js", () => ({ resolveProviderId: (provider) => provider }));

const { affinityIdentity, claimOwner, readOwner, resolveOwner, setPin } =
  await import("@/sse/services/sessionAffinity.js");
const workerPath = fileURLToPath(new URL("../fixtures/session-owner-worker.mjs", import.meta.url));
let db;
let directory;
let dbPath;
const workers = new Set();

function adapterFor(sqlite) {
  return {
    get: (sql, params) => sqlite.prepare(sql).get(...params),
    run: (sql, params) => sqlite.prepare(sql).run(...params),
  };
}

function startWorker(candidate) {
  const child = fork(workerPath, [], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: { AFFINITY_TEST_DB: dbPath, AFFINITY_TEST_CANDIDATE: candidate, NODE_NO_WARNINGS: "1" },
  });
  workers.add(child);
  let ready;
  let result;
  const whenReady = new Promise((resolve, reject) => { ready = { resolve, reject }; });
  const whenResult = new Promise((resolve, reject) => { result = { resolve, reject }; });
  child.on("message", (message) => {
    if (message.ready) ready.resolve();
    else if (message.error) result.reject(new Error(message.error));
    else result.resolve(message);
  });
  child.on("error", (error) => { ready.reject(error); result.reject(error); });
  child.on("exit", (code) => {
    workers.delete(child);
    if (code !== 0) {
      ready.reject(new Error(`worker exit ${code}`));
      result.reject(new Error(`worker exit ${code}`));
    }
  });
  return { child, whenReady, whenResult };
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ninerouter-owner-"));
  dbPath = join(directory, "fixture.sqlite");
  db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000");
  db.exec("CREATE TABLE kv (scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(scope, key))");
  fixture.adapter = adapterFor(db);
});
afterEach(() => {
  for (const child of workers) child.kill();
  workers.clear();
  db.close();
  fixture.adapter = null;
  rmSync(directory, { recursive: true, force: true });
});

describe("SQLite durable session ownership", () => {
  it("refuses sql.js snapshots even when they contain an existing owner", async () => {
    const identity = affinityIdentity("session", "codex", "key");
    await claimOwner(identity, "conn-A");
    fixture.adapter.driver = "sql.js";
    await expect(resolveOwner(identity)).rejects.toThrow("requires a native SQLite driver");
    await expect(claimOwner(identity, "conn-B")).rejects.toThrow("requires a native SQLite driver");
    expect(await readOwner(identity)).toMatchObject({ connectionId: "conn-A" });
  });

  it("persists a winner across DB close/reopen and expired leases", async () => {
    const identity = affinityIdentity("session", "codex", "key");
    expect(await claimOwner(identity, "conn-A", 1000)).toMatchObject({ created: true,
      owner: { connectionId: "conn-A", createdAt: 1000 } });
    await setPin(identity, "conn-A", 1000, 1000);
    db.close();
    db = new DatabaseSync(dbPath);
    fixture.adapter = adapterFor(db);
    expect(await readOwner(identity)).toMatchObject({ connectionId: "conn-A" });
    expect(await resolveOwner(identity, 8 * 86_400_000)).toMatchObject({ connectionId: "conn-A" });
    expect(await claimOwner(identity, "conn-B", 8 * 86_400_000)).toMatchObject({ created: false,
      owner: { connectionId: "conn-A" } });
  });

  it("promotes an already expired legacy row without deleting another's evidence", async () => {
    const identity = affinityIdentity("old-session", "codex", "key");
    const other = affinityIdentity("other-session", "codex", "key");
    for (const entry of [identity, other]) {
      db.prepare("INSERT INTO kv(scope, key, value) VALUES (?, ?, ?)")
        .run("sessionAccountAffinity", entry.key, JSON.stringify({ connectionId: "conn-original", expiresAt: 1 }));
    }
    expect(await resolveOwner(identity)).toMatchObject({ connectionId: "conn-original" });
    expect(await readOwner(other)).toBeNull();
    expect(await resolveOwner(other)).toMatchObject({ connectionId: "conn-original" });
  });

  it("arbitrates simultaneous first turns from independent Node processes", async () => {
    const contenders = ["conn-A", "conn-B", "conn-C"].map(startWorker);
    await Promise.all(contenders.map((worker) => worker.whenReady));
    contenders.forEach((worker) => worker.child.send({ start: true }));
    const results = await Promise.all(contenders.map((worker) => worker.whenResult));
    expect(new Set(results.map((result) => result.connectionId)).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    const identity = affinityIdentity("concurrent-session", "codex", "fixture-key");
    expect((await readOwner(identity)).connectionId).toBe(results[0].connectionId);
  }, 15_000);
});
