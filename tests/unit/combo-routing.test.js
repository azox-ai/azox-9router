import { describe, it, expect, beforeEach, vi } from "vitest";

import { getRotatedModels, handleComboChat, resetComboRotation } from "../../open-sse/services/combo.js";

describe("combo round-robin routing", () => {
  beforeEach(() => {
    resetComboRotation();
  });

  it("keeps existing one-request round-robin behavior by default", () => {
    const models = ["provider/model-a", "provider/model-b"];

    const firstChoices = Array.from({ length: 4 }, () => (
      getRotatedModels(models, "code-xhigh", "round-robin")[0]
    ));

    expect(firstChoices).toEqual([
      "provider/model-a",
      "provider/model-b",
      "provider/model-a",
      "provider/model-b",
    ]);
  });

  it("sticks to each combo model for the configured number of requests", () => {
    const models = ["provider/model-a", "provider/model-b"];

    const firstChoices = Array.from({ length: 6 }, () => (
      getRotatedModels(models, "code-xhigh", "round-robin", 2)[0]
    ));

    expect(firstChoices).toEqual([
      "provider/model-a",
      "provider/model-a",
      "provider/model-b",
      "provider/model-b",
      "provider/model-a",
      "provider/model-a",
    ]);
  });

  it("tracks sticky rotation independently per combo", () => {
    const models = ["provider/model-a", "provider/model-b"];

    expect(getRotatedModels(models, "code-high", "round-robin", 2)[0]).toBe("provider/model-a");
    expect(getRotatedModels(models, "code-xhigh", "round-robin", 2)[0]).toBe("provider/model-a");
    expect(getRotatedModels(models, "code-high", "round-robin", 2)[0]).toBe("provider/model-a");
    expect(getRotatedModels(models, "code-high", "round-robin", 2)[0]).toBe("provider/model-b");
    expect(getRotatedModels(models, "code-xhigh", "round-robin", 2)[0]).toBe("provider/model-a");
  });

  it("does not rotate fallback combos", () => {
    const models = ["provider/model-a", "provider/model-b"];

    expect(getRotatedModels(models, "code-xhigh", "fallback", 2)).toEqual(models);
    expect(getRotatedModels(models, "code-xhigh", "fallback", 2)).toEqual(models);
  });
});

describe("combo session owner failures", () => {
  const log = { info: vi.fn(), warn: vi.fn() };
  const models = ["provider/model-a", "other/model-b"];
  const conflict = () => new Response(JSON.stringify({ error: {
    code: "session_affinity_unavailable", message: "Owner temporarily unavailable",
  } }), { status: 409, headers: { "Content-Type": "application/json" } });

  it("returns a terminal affinity response without trying another combo model", async () => {
    const handleSingleModel = vi.fn().mockResolvedValueOnce(conflict());
    const result = await handleComboChat({ body: {}, models, handleSingleModel, log });
    expect(result.status).toBe(409);
    expect((await result.json()).error.code).toBe("session_affinity_unavailable");
    expect(handleSingleModel).toHaveBeenCalledTimes(1);
  });

  it("does not fall through on a thrown affinity failure", async () => {
    const handleSingleModel = vi.fn().mockRejectedValueOnce(Object.assign(new Error("Owner unavailable"), {
      code: "session_affinity_unavailable", retryable: true,
    }));
    const result = await handleComboChat({ body: {}, models, handleSingleModel, log });
    expect(result.status).toBe(409);
    expect((await result.json()).error.code).toBe("session_affinity_unavailable");
    expect(handleSingleModel).toHaveBeenCalledTimes(1);
  });

  it("does not switch providers for a bound session on an upstream outage", async () => {
    const handleSingleModel = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: "upstream unavailable" } }), { status: 503 })
    );
    const result = await handleComboChat({ body: {}, models, handleSingleModel, log, allowFallback: false });
    expect(result.status).toBe(503);
    expect(handleSingleModel).toHaveBeenCalledTimes(1);
  });

  it("does not switch providers for a bound session on a thrown exception", async () => {
    const handleSingleModel = vi.fn().mockRejectedValueOnce(new Error("upstream failed"));
    const result = await handleComboChat({ body: {}, models, handleSingleModel, log, allowFallback: false });
    expect(result.status).toBe(409);
    expect((await result.json()).error.code).toBe("session_affinity_unavailable");
    expect(handleSingleModel).toHaveBeenCalledTimes(1);
  });

  it("keeps sessionless retry on an ordinary upstream failure", async () => {
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(new Response("upstream unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const result = await handleComboChat({ body: {}, models, handleSingleModel, log });
    expect(result.status).toBe(200);
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
  });
});
