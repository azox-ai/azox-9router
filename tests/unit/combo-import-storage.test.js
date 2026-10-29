import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNodeSqliteAdapter } from "../../src/lib/db/adapters/nodeSqliteAdapter.js";
import { TABLES, buildCreateTableSql } from "../../src/lib/db/schema.js";

const state = vi.hoisted(() => ({ db: null }));
vi.mock("../../src/lib/db/driver.js", () => ({ getAdapter: async () => state.db }));
const repo = await import("../../src/lib/db/repos/combosRepo.js");
const smart = { fallbackStrategy: "smart", routerModel: "cx/router", smartPolicy: "custom", sessionSticky: true, confidenceThreshold: 0.73 };
const item = (name = "balanced", strategy = smart) => ({ index: 0, name, kind: "chat", models: ["cx/a", "cc/b"], strategy, strategyProvided: true });
const settings = () => JSON.parse(state.db.get("SELECT data FROM settings WHERE id = 1").data);

beforeEach(async () => {
  state.db = await createNodeSqliteAdapter(":memory:");
  for (const table of ["settings", "combos"]) state.db.exec(buildCreateTableSql(table, TABLES[table]));
  state.db.run("INSERT INTO settings(id, data) VALUES(1, ?)", [JSON.stringify({ comboStrategy: "fallback", apiKey: "DUMMY-PRIVATE", comboStrategies: { unrelated: { fallbackStrategy: "fusion" } } })]);
});
afterEach(() => state.db.close());

describe("atomic combo import on real SQLite", () => {
  it("exposes the import capability on the candidate", () => {
    expect(repo.importComboItems).toBeTypeOf("function");
  });
  it("stores combo and Smart settings together without changing global settings", async () => {
    expect(repo.importComboItems).toBeTypeOf("function");
    expect((await repo.importComboItems([item()]))[0].action).toBe("created");
    expect(await repo.getComboByName("balanced")).toMatchObject({ name: "balanced", kind: "chat", models: ["cx/a", "cc/b"] });
    expect(settings()).toEqual({ comboStrategy: "fallback", apiKey: "DUMMY-PRIVATE", comboStrategies: { unrelated: { fallbackStrategy: "fusion" }, balanced: smart } });
  });
  it("skips collisions and identical imports, updates changed definitions", async () => {
    expect(repo.importComboItems).toBeTypeOf("function");
    await repo.importComboItems([item()]);
    const changed = { ...item(), models: ["cx/new"] };
    expect((await repo.importComboItems([changed], { conflictPolicy: "skip" }))[0].action).toBe("skipped");
    expect((await repo.getComboByName("balanced")).models).toEqual(["cx/a", "cc/b"]);
    expect((await repo.importComboItems([item()]))[0].action).toBe("skipped");
    expect((await repo.importComboItems([changed]))[0].action).toBe("updated");
    expect((await repo.getComboByName("balanced")).models).toEqual(["cx/new"]);
  });
  it("preserves existing strategy for definition-only imports", async () => {
    expect(repo.importComboItems).toBeTypeOf("function");
    await repo.importComboItems([item()]);
    await repo.importComboItems([{ ...item(), models: ["cx/new"], strategy: {}, strategyProvided: false }]);
    expect(settings().comboStrategies.balanced).toEqual(smart);
    expect(settings().comboStrategy).toBe("fallback");
  });
  it("rolls back all valid siblings when a later SQLite write fails", async () => {
    expect(repo.importComboItems).toBeTypeOf("function");
    state.db.exec("CREATE TRIGGER reject_bad BEFORE INSERT ON combos WHEN NEW.name = 'bad' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END");
    await expect(repo.importComboItems([item(), { ...item("bad"), index: 1 }])).rejects.toThrow("synthetic failure");
    expect(await repo.getCombos()).toEqual([]);
    expect(settings().comboStrategies).toEqual({ unrelated: { fallbackStrategy: "fusion" } });
  });
  it("rolls back definitions when strategy settings cannot be committed", async () => {
    expect(repo.importComboItems).toBeTypeOf("function");
    state.db.exec("CREATE TRIGGER reject_settings BEFORE UPDATE ON settings BEGIN SELECT RAISE(ABORT, 'settings failure'); END");
    await expect(repo.importComboItems([item()])).rejects.toThrow("settings failure");
    expect(await repo.getCombos()).toEqual([]);
  });
});
