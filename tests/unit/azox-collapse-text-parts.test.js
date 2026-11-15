import { describe, expect, it } from "vitest";
import { collapseTextParts } from "../../open-sse/translator/concerns/message.js";

const t = (text, extra = {}) => ({ type: "text", text, ...extra });

describe("AZOX collapseTextParts", () => {
  it("joins metadata-free text parts by default", () => {
    expect(collapseTextParts([t("a"), t("b")])).toBe("a\nb");
  });
  it("keeps separate parts when keepTextParts is set (Gemini #2393)", () => {
    expect(collapseTextParts([t("a"), t("b")], { keepTextParts: true })).toEqual([t("a"), t("b")]);
  });
  it("keeps arrays carrying block metadata or non-text parts", () => {
    const marked = [t("a", { cache_control: { type: "ephemeral" } }), t("b")];
    expect(collapseTextParts(marked)).toBe(marked);
    const image = [t("a"), { type: "image_url", image_url: { url: "data:x" } }];
    expect(collapseTextParts(image)).toBe(image);
  });
  it("retains a lone cache-marked block only for cache-aware targets", () => {
    const one = [t("a", { cache_control: { type: "ephemeral" } })];
    expect(collapseTextParts(one)).toBe("a");
    expect(collapseTextParts(one, { preserveCacheControl: true })).toBe(one);
  });
});
