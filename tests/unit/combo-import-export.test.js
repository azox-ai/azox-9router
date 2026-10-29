import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCombos: vi.fn(), getSettings: vi.fn(), importComboItems: vi.fn(), resetComboRotation: vi.fn(),
}));
vi.mock("next/server", () => ({ NextResponse: { json: (body, init) => Response.json(body, init) } }));
vi.mock("@/lib/db/index.js", () => mocks);
vi.mock("open-sse/services/combo.js", () => ({ resetComboRotation: mocks.resetComboRotation }));
const route = await import("../../src/app/api/import-export/combos/route.js");
const combo = { name: "balanced", kind: "chat", models: ["cx/gpt", "cc/claude"] };
const smart = { fallbackStrategy: "smart", routerModel: "cx/router", smartPolicy: "custom", sessionSticky: true, confidenceThreshold: 0.73 };
function request(body, headers = {}) {
  return new Request("https://router.example/api/import-export/combos", {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  });
}
beforeEach(() => {
  mocks.getCombos.mockReset().mockResolvedValue([combo]);
  mocks.getSettings.mockReset().mockResolvedValue({ comboStrategies: { balanced: smart }, apiKey: "DO-NOT-EXPORT" });
  mocks.importComboItems.mockReset().mockResolvedValue([{ index: 0, name: "balanced", action: "updated" }]);
  mocks.resetComboRotation.mockReset();
});
describe("combo import/export contract", () => {
  it("exports Smart metadata losslessly without unrelated settings", async () => {
    const response = await route.GET();
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(payload.combos).toEqual([{ ...combo, settings: smart }]);
    expect(JSON.stringify(payload)).not.toContain("DO-NOT-EXPORT");
  });
  it("round-trips exported Smart metadata to the transaction seam", async () => {
    const payload = await (await route.GET()).json();
    expect((await route.POST(request(payload))).status).toBe(200);
    expect(mocks.importComboItems).toHaveBeenCalledWith([{ index: 0, ...combo, strategy: smart, strategyProvided: true }], { conflictPolicy: "update" });
    expect(mocks.resetComboRotation).toHaveBeenCalledWith("balanced");
  });
  it("exports unknown saved strategies with the sourced fallback default", async () => {
    mocks.getSettings.mockResolvedValue({ comboStrategies: { balanced: { fallbackStrategy: "unknown" } } });
    const response = await route.GET();
    expect(response.status).toBe(200);
    expect((await response.json()).combos[0].settings).toEqual({ fallbackStrategy: "fallback" });
  });
  it.each([{ format: "other" }, { version: 2 }])("keeps sourced envelope compatibility: %j", async (metadata) => {
    expect((await route.POST(request({ ...metadata, combos: [combo] }))).status).toBe(200);
    expect(mocks.importComboItems).toHaveBeenCalledWith([{ index: 0, ...combo, strategy: {}, strategyProvided: false }], { conflictPolicy: "update" });
  });
  it("ignores unknown strategy and fusion tuning fields as the source does", async () => {
    const payload = await (await route.POST(request({ combos: [{ ...combo, settings: { fallbackStrategy: "fusion", extraMetadata: true, fusionTuning: { minPanel: 2, futureField: 1 } } }] }))).json();
    expect(payload.summary.failed).toBe(0);
    expect(mocks.importComboItems.mock.calls[0][0][0].strategy).toEqual({ fallbackStrategy: "fusion", fusionTuning: { minPanel: 2 } });
  });
  it.each(["unknown", "CUSTOM"])("preserves Smart policy strings accepted by runtime: %s", async (smartPolicy) => {
    const strategy = { ...smart, smartPolicy };
    const response = await route.POST(request({ combos: [{ ...combo, settings: strategy }] }));
    expect((await response.json()).summary.failed).toBe(0);
    expect(mocks.importComboItems.mock.calls[0][0][0].strategy).toEqual(strategy);
  });
  it.each([2, -1, 0])("preserves runtime numeric threshold input: %j", async (confidenceThreshold) => {
    const strategy = { ...smart, confidenceThreshold };
    const response = await route.POST(request({ combos: [{ ...combo, settings: strategy }] }));
    expect((await response.json()).summary.failed).toBe(0);
    expect(mocks.importComboItems.mock.calls[0][0][0].strategy).toEqual(strategy);
  });
  it("keeps sourced per-item validation while importing valid siblings", async () => {
    const response = await route.POST(request({ combos: [{ ...combo, settings: { fallbackStrategy: "round-robin" } }, { name: "bad", models: ["cx/model"], settings: { fallbackStrategy: "unknown" } }] }));
    expect(response.status).toBe(200);
    expect((await response.json()).summary).toMatchObject({ updated: 1, failed: 1 });
    expect(mocks.importComboItems.mock.calls[0][0]).toHaveLength(1);
  });
  it("reports an empty combo as a failed item without writes", async () => {
    const response = await route.POST(request({ combos: [{ name: "empty", models: [] }] }));
    expect(response.status).toBe(200);
    expect((await response.json()).summary.failed).toBe(1);
    expect(mocks.importComboItems).not.toHaveBeenCalled();
  });
  it("does not set strategy on definition-only import", async () => {
    await route.POST(request({ combos: [combo] }));
    expect(mocks.importComboItems).toHaveBeenCalledWith([{ index: 0, ...combo, strategy: {}, strategyProvided: false }], { conflictPolicy: "update" });
  });
  it.each(["smart", "strict", "per-turn", "custom", "smart-switch-70", "smart-switch-90"])("preserves supported Smart policy %s", async (smartPolicy) => {
    const strategy = { ...smart, smartPolicy, sessionSticky: smartPolicy !== "per-turn", confidenceThreshold: 0 };
    await route.POST(request({ combos: [{ ...combo, settings: strategy }] }));
    expect(mocks.importComboItems.mock.calls[0][0][0].strategy).toEqual(strategy);
  });
  it("preserves fusion tuning and metadata even when currently inactive", async () => {
    const strategy = { ...smart, fallbackStrategy: "fallback", judgeModel: "cx/judge", fusionTuning: { minPanel: 2, stragglerGraceMs: 800, panelHardTimeoutMs: 3000 } };
    mocks.getSettings.mockResolvedValue({ comboStrategies: { balanced: strategy } });
    const payload = await (await route.GET()).json();
    await route.POST(request(payload));
    expect(mocks.importComboItems.mock.calls[0][0][0].strategy).toEqual(strategy);
  });
  it.each([{ routerModel: 4 }, { routerModel: "x".repeat(501) }, { smartPolicy: 5 }, { sessionSticky: {} }, { confidenceThreshold: "0.73" }, { confidenceThreshold: Number.NaN }])("reports malformed Smart metadata types without storing it: %j", async (invalid) => {
    const payload = await (await route.POST(request({ combos: [{ ...combo, settings: { ...smart, ...invalid } }] }))).json();
    expect(payload.summary.failed).toBe(1);
    expect(mocks.importComboItems).not.toHaveBeenCalled();
  });
  it.each(["comboStrategies", "settings"])("accepts legacy strategy map %s and explicit skip collisions", async (key) => {
    const map = { balanced: { fallbackStrategy: "round-robin" } };
    const payload = { items: [combo], [key]: key === "settings" ? { comboStrategies: map } : map, conflictPolicy: "skip" };
    mocks.importComboItems.mockResolvedValue([{ index: 0, name: combo.name, action: "skipped" }]);
    await route.POST(request({ data: payload }));
    expect(mocks.importComboItems).toHaveBeenCalledWith([{ index: 0, ...combo, strategy: map.balanced, strategyProvided: true }], { conflictPolicy: "skip" });
    expect(mocks.resetComboRotation).not.toHaveBeenCalled();
  });
  it("reports duplicate names rather than applying them twice", async () => {
    const payload = await (await route.POST(request([combo, combo]))).json();
    expect(payload.summary.failed).toBe(1);
    expect(mocks.importComboItems.mock.calls[0][0]).toHaveLength(1);
  });
  it.each([{ combos: [] }, { combos: Array(501).fill(combo) }, { combos: [combo], conflictPolicy: "replace" }])("rejects invalid envelope: %j", async (body) => {
    expect((await route.POST(request(body))).status).toBe(400);
    expect(mocks.importComboItems).not.toHaveBeenCalled();
  });
  it("rejects declared and streamed bodies larger than 2 MiB and releases readers", async () => {
    for (const req of [request({ combos: [combo] }, { "content-length": String(2 * 1024 * 1024 + 1) }), request({ padding: "x".repeat(2 * 1024 * 1024), combos: [combo] })]) {
      expect((await route.POST(req)).status).toBe(413);
      expect(req.body.locked).toBe(false);
    }
    expect(mocks.importComboItems).not.toHaveBeenCalled();
  });
  it("rejects malformed JSON and UTF-8 without echoing payload or logs", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const body of ["{DO-NOT-LOG", new Uint8Array([0xff])]) {
        const req = new Request("https://router.example/api/import-export/combos", { method: "POST", body });
        const response = await route.POST(req);
        expect(response.status).toBe(400);
        expect(JSON.stringify(await response.json())).not.toContain("DO-NOT-LOG");
      }
      expect(JSON.stringify(spy.mock.calls)).not.toContain("DO-NOT-LOG");
    } finally { spy.mockRestore(); }
  });
});
