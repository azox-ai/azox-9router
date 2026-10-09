import { describe, expect, it } from "vitest";

import { CodexExecutor } from "../../open-sse/executors/codex.js";

function normalize(body) {
  new CodexExecutor().transformRequest("gpt-5.5", body, true, {
    connectionId: "test-codex-search",
    providerSpecificData: {},
  });
}

describe("Codex hosted search compatibility", () => {
  for (const type of ["web_search_preview", "web_search_preview_2025_03_11"]) {
    it(`canonicalizes ${type} without dropping search controls`, () => {
      const tool = {
        type,
        search_context_size: "low",
        filters: { allowed_domains: ["developers.openai.com"] },
        external_web_access: false,
        user_location: { type: "approximate", country: "VN" },
      };
      const expected = { ...structuredClone(tool), type: "web_search" };
      const body = { input: "probe", tools: [tool], tool_choice: { type } };
      normalize(body);
      expect(body.tools).toEqual([expected]);
      expect(body.tool_choice).toEqual({ type: "web_search" });
    });
  }

  it("leaves normal functions, custom tools, namespaces and other hosted tools unchanged", () => {
    const tools = [
      { type: "web_search", external_web_access: true },
      { type: "function", name: "web_search", parameters: { type: "object" } },
      { type: "custom", name: "web_search", format: { type: "text" } },
      { type: "image_generation", output_format: "png" },
      { type: "namespace", name: "mcp__probe__", tools: [] },
    ];
    const expected = structuredClone(tools);
    const body = { input: "probe", tools };
    normalize(body);
    expect(body.tools).toEqual(expected);
  });
});
