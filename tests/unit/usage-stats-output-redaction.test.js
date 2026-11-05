import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// Reverting the public-output projection must expose a raw fixture key here.
// Mask-based grouping must also fail: A and B have identical display masks.
const keyA = "synthetic-prefix-alpha-TAIL";
const keyB = "synthetic-prefix-bravo-TAIL";
const deletedKey = "synthetic-deleted-charlie-ENDS";
const rawKeys = [keyA, keyB, deletedKey];
const periods = ["all", "7d", "30d", "60d", "24h", "today"];
let db, dir, timestamp, beforeDeleteIds;
const previousDataDir = process.env.DATA_DIR;

function assertNoRawKeys(serialized) {
  for (const key of rawKeys) {
    // Boolean assertion deliberately avoids echoing synthetic credentials.
    expect(serialized.includes(key), "raw fixture key in serialized output").toBe(false);
  }
}

function ids(stats) {
  return Object.keys(stats.byApiKey).sort();
}

function assertAttribution(stats) {
  expect(stats).toMatchObject({
    totalRequests: 8, totalPromptTokens: 360, totalCompletionTokens: 72,
    totalCachedTokens: 36, totalCost: 486,
  });
  const entries = Object.values(stats.byApiKey);
  expect(entries).toHaveLength(7);
  const shared = entries.filter((e) => e.keyName === "Shared" && e.rawModel === "model-one" && e.provider === "fixture-one");
  expect(shared).toHaveLength(2);
  expect(shared.map((e) => e.apiKeyMasked)).toEqual(["syntheti***TAIL", "syntheti***TAIL"]);
  expect(shared.map((e) => [e.requests, e.promptTokens, e.completionTokens, e.cachedTokens, e.cost]).sort((a, b) => a[0] - b[0]))
    .toEqual([[1, 30, 6, 3, 40.5], [2, 30, 6, 3, 40.5]]);
  expect(entries.filter((e) => e.keyName === "Shared").map((e) => `${e.rawModel}/${e.provider}`).sort())
    .toEqual(["model-one/fixture-one", "model-one/fixture-one", "model-one/fixture-two", "model-two/fixture-one"]);
  const local = entries.filter((e) => e.apiKeyMasked === null);
  expect(local.map((e) => [e.rawModel, e.provider, e.promptTokens, e.cost]).sort())
    .toEqual([["model-one", "fixture-one", 60, 81], ["model-two", "fixture-two", 70, 94.5]]);
  expect(local.every((e) => e.keyName === "Local (No API Key)")).toBe(true);
  const deleted = entries.find((e) => e.apiKeyMasked === "syntheti***ENDS");
  expect(deleted).toMatchObject({ keyName: "syntheti***ENDS", requests: 1, promptTokens: 80, completionTokens: 16, cachedTokens: 8, cost: 108 });
  expect(entries.every((e) => e.lastUsed === timestamp)).toBe(true);
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-output-"));
  process.env.DATA_DIR = dir;
  db = await import("@/lib/db/index.js");
  await db.initDb();
  const { getAdapter } = await import("@/lib/db/driver.js");
  const adapter = await getAdapter();
  for (const [id, key, name] of [["fixture-a", keyA, "Shared"], ["fixture-b", keyB, "Shared"], ["fixture-c", deletedKey, "Deleted"]]) {
    adapter.run("INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt) VALUES(?, ?, ?, ?, ?, ?)",
      [id, key, name, "synthetic-machine", 1, new Date().toISOString()]);
  }
  const pricing = { input: 1000000, output: 2000000, cached: 500000 };
  await db.updatePricing({ "fixture-one": { "model-one": pricing, "model-two": pricing }, "fixture-two": { "model-one": pricing, "model-two": pricing } });
  timestamp = new Date().toISOString();
  const fixtures = [
    [keyA, "model-one", "fixture-one", 10], [keyA, "model-one", "fixture-one", 20],
    [keyB, "model-one", "fixture-one", 30], [keyA, "model-two", "fixture-one", 40],
    [keyA, "model-one", "fixture-two", 50], [null, "model-one", "fixture-one", 60],
    [null, "model-two", "fixture-two", 70], [deletedKey, "model-one", "fixture-one", 80],
  ];
  for (const [apiKey, model, provider, prompt] of fixtures) {
    await db.saveRequestUsage({ timestamp, apiKey, model, provider, endpoint: "/fixture/chat",
      tokens: { prompt_tokens: prompt, completion_tokens: prompt / 5, cached_tokens: prompt / 10 } });
  }
  // saveRequestUsage catches errors; verify real writes before testing output.
  expect(adapter.get("SELECT COUNT(*) AS count FROM usageHistory").count).toBe(8);
  expect(adapter.get("SELECT COUNT(*) AS count FROM usageDaily").count).toBe(1);
  beforeDeleteIds = ids(await db.getUsageStats("all"));
  expect(await db.deleteApiKey("fixture-c")).toBe(true);
  for (const timer of Object.values(global._statsEmitTimers)) clearTimeout(timer);
}, 20000);

afterAll(() => {
  for (const timer of Object.values(global._statsEmitTimers || {})) clearTimeout(timer);
  global._dbAdapter?.instance?.close?.();
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe("usage statistics public output", () => {
  for (const period of periods) {
    it(`${period} contains no raw fixture keys in names or values`, async () => {
      assertNoRawKeys(JSON.stringify(await db.getUsageStats(period)));
    });
    it(`${period} preserves separate key/model/provider groups and amounts`, async () => {
      assertAttribution(await db.getUsageStats(period));
    });
  }

  it("keeps public identities stable across repeated, live, daily and deleted-key reads", async () => {
    for (const period of periods) {
      const stats = await db.getUsageStats(period);
      assertNoRawKeys(JSON.stringify(stats));
      expect(JSON.stringify(ids(stats)) === JSON.stringify(beforeDeleteIds)).toBe(true);
      expect(JSON.stringify(ids(await db.getUsageStats(period))) === JSON.stringify(ids(stats))).toBe(true);
    }
  });

  it("history producer masks credentials without losing rows or cost", async () => {
    const rows = await db.getUsageHistory();
    assertNoRawKeys(JSON.stringify(rows));
    expect(rows).toHaveLength(8);
    expect(rows.reduce((sum, row) => sum + row.cost, 0)).toBe(486);
  });

  it("REST stats serializes safe output for daily and live paths", async () => {
    const { GET } = await import("@/app/api/usage/stats/route.js");
    for (const period of periods) {
      const response = await GET(new Request(`http://fixture.invalid/api/usage/stats?period=${period}`));
      expect(response.status).toBe(200);
      const serialized = await response.text();
      assertNoRawKeys(serialized);
      assertAttribution(JSON.parse(serialized));
    }
  });

  it("REST history serializes safe daily stats", async () => {
    const { GET } = await import("@/app/api/usage/history/route.js");
    const response = await GET();
    expect(response.status).toBe(200);
    const serialized = await response.text();
    assertNoRawKeys(serialized);
    assertAttribution(JSON.parse(serialized));
  });

  it("SSE initial, cached pending, quick update and full update serialize no raw keys", async () => {
    const { GET } = await import("@/app/api/usage/stream/route.js");
    const before = [db.statsEmitter.listenerCount("update"), db.statsEmitter.listenerCount("pending")];
    const response = await GET();
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const frames = [];
    try {
      frames.push(decoder.decode((await reader.read()).value));
      // Await the stream's async start completion before emitting events.
      await new Promise((resolve) => setTimeout(resolve, 0));
      db.statsEmitter.emit("pending");
      frames.push(decoder.decode((await reader.read()).value));
      db.statsEmitter.emit("update");
      frames.push(decoder.decode((await reader.read()).value));
      frames.push(decoder.decode((await reader.read()).value));
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    expect([db.statsEmitter.listenerCount("update"), db.statsEmitter.listenerCount("pending")]).toEqual(before);
    expect(frames).toHaveLength(4);
    for (const frame of frames) {
      expect(frame.startsWith("data: ")).toBe(true);
      assertNoRawKeys(frame);
      assertAttribution(JSON.parse(frame.slice(6).trim()));
    }
  });
});
