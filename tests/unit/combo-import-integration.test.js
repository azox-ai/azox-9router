import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNodeSqliteAdapter } from "../../src/lib/db/adapters/nodeSqliteAdapter.js";
import { TABLES, buildCreateTableSql } from "../../src/lib/db/schema.js";
import { getRotatedModels, resetComboRotation } from "open-sse/services/combo.js";

const state = vi.hoisted(() => ({ db: null }));
vi.mock("../../src/lib/db/driver.js", () => ({ getAdapter: async () => state.db }));
vi.mock("next/server", () => ({ NextResponse: { json: (body, init) => Response.json(body, init) } }));
vi.mock("@/lib/db/index.js", async () => ({
  ...await import("../../src/lib/db/repos/combosRepo.js"),
  ...await import("../../src/lib/db/repos/settingsRepo.js"),
}));
const { GET, POST } = await import("../../src/app/api/import-export/combos/route.js");
const models = ["cx/a", "cc/b", "cx/c"];
const combo = { name: "integration", kind: "chat", models };
const smart = { fallbackStrategy: "smart", routerModel: "cx/router", smartPolicy: "custom", sessionSticky: false, confidenceThreshold: 0.71 };
function request(data) {
  return new Request("https://router.example/api/import-export/combos", { method: "POST", body: JSON.stringify(data) });
}
const stored = () => JSON.parse(state.db.get("SELECT data FROM settings WHERE id = 1").data);
beforeEach(async () => {
  state.db = await createNodeSqliteAdapter(":memory:");
  for (const name of ["settings", "combos"]) state.db.exec(buildCreateTableSql(name, TABLES[name]));
  state.db.run("INSERT INTO settings(id, data) VALUES(1, ?)", [JSON.stringify({ comboStrategy: "fallback", requireLogin: true, apiKey: "PRIVATE-FIXTURE", comboStrategies: {} })]);
  resetComboRotation();
});
afterEach(() => { state.db.close(); resetComboRotation(); });

describe("combo transfer route with real SQLite and rotation", () => {
  it("round-trips complete Smart metadata through export, deletion and import", async () => {
    await POST(request({ combos: [{ ...combo, settings: smart }] }));
    const exported = await (await GET()).json();
    expect(exported.combos).toEqual([{ ...combo, settings: smart }]);
    expect(JSON.stringify(exported)).not.toContain("PRIVATE-FIXTURE");
    state.db.exec("DELETE FROM combos");
    state.db.run("UPDATE settings SET data = ? WHERE id = 1", [JSON.stringify({ ...stored(), comboStrategies: {} })]);
    expect((await (await POST(request(exported))).json()).summary.created).toBe(1);
    expect((await (await GET()).json()).combos).toEqual(exported.combos);
    expect(stored()).toMatchObject({ comboStrategy: "fallback", requireLogin: true, apiKey: "PRIVATE-FIXTURE", comboStrategies: { integration: smart } });
  });
  it("resets rotation on changed import but not on identical or skipped imports", async () => {
    await POST(request({ combos: [{ ...combo, settings: { fallbackStrategy: "round-robin" } }] }));
    expect(getRotatedModels(models, combo.name, "round-robin")[0]).toBe(models[0]);
    await POST(request({ combos: [{ ...combo, settings: { fallbackStrategy: "round-robin" } }] }));
    expect(getRotatedModels(models, combo.name, "round-robin")[0]).toBe(models[1]);
    await POST(request({ conflictPolicy: "skip", combos: [{ ...combo, kind: "changed" }] }));
    expect(getRotatedModels(models, combo.name, "round-robin")[0]).toBe(models[2]);
    await POST(request({ combos: [{ ...combo, kind: "changed" }] }));
    expect(getRotatedModels(models, combo.name, "round-robin")[0]).toBe(models[0]);
  });
  it("preserves inherited strategy absence instead of materializing fallback or Smart", async () => {
    await POST(request({ combos: [combo] }));
    expect((await (await GET()).json()).combos[0].settings).toEqual({});
    expect(stored().comboStrategies).toEqual({});
  });
  it("returns only generic storage errors and rolls back definitions and settings", async () => {
    state.db.exec("CREATE TRIGGER fail_settings BEFORE UPDATE ON settings BEGIN SELECT RAISE(ABORT, 'PRIVATE-FIXTURE'); END");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await POST(request({ combos: [{ ...combo, settings: smart }] }));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Failed to import combos" });
      expect(JSON.stringify(log.mock.calls)).not.toContain("PRIVATE-FIXTURE");
      expect(state.db.all("SELECT * FROM combos")).toEqual([]);
      expect(stored().comboStrategies).toEqual({});
    } finally { log.mockRestore(); }
  });
});
