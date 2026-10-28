import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
}));
vi.mock("@/lib/localDb", () => db);
vi.mock("@/lib/network/connectionProxy", () => ({
  pickProxyPoolId: vi.fn(), resolveConnectionProxyConfig: vi.fn(),
}));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {}, resolveProviderId: provider => provider,
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));

import { checkFallbackError } from "../../open-sse/services/accountFallback.js";
import { handleComboChat } from "../../open-sse/services/combo.js";
import { markAccountUnavailable } from "../../src/sse/services/auth.js";

const message = "This model does not support assistant message prefill. The conversation must end with a user message.";
const failure = () => new Response(JSON.stringify({ error: { type: "invalid_request_error", message } }), {
  status: 400, headers: { "content-type": "application/json" },
});
const log = { info: () => {}, warn: () => {}, debug: () => {} };

beforeEach(() => {
  vi.clearAllMocks();
  db.getProviderConnections.mockResolvedValue([{ id: "fixture-claude", provider: "claude", backoffLevel: 2 }]);
});

describe("AZOX prefill rejection integration", () => {
  it("classifies prefill as request-scoped without account cooldown", () => {
    expect(checkFallbackError(400, message, 2, "claude")).toMatchObject({ shouldFallback: false, cooldownMs: 0 });
  });

  it("leaves account state untouched on prefill rejection", async () => {
    expect(await markAccountUnavailable("fixture-claude", 400, message, "claude", "claude-sonnet-4-5"))
      .toMatchObject({ shouldFallback: false, cooldownMs: 0 });
    expect(db.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("tries the next combo member without changing the rejected account", async () => {
    const attempts = [];
    const result = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["claude/claude-sonnet-4-5", "openai/test-model"],
      comboStrategy: "fallback", log,
      handleSingleModel: async (_body, model) => {
        attempts.push(model);
        if (model.startsWith("claude/")) {
          await markAccountUnavailable("fixture-claude", 400, message, "claude", "claude-sonnet-4-5");
          return failure();
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: "served" } }] }), {
          headers: { "content-type": "application/json" },
        });
      },
    });
    expect(result.status).toBe(200);
    expect((await result.json()).choices[0].message.content).toBe("served");
    expect(attempts).toEqual(["claude/claude-sonnet-4-5", "openai/test-model"]);
    expect(db.updateProviderConnection).not.toHaveBeenCalled();
  });

  it.each([401, 429, 503])("keeps account fallback for unrelated status %s", status => {
    expect(checkFallbackError(status, "unrelated provider failure", 0, "claude").shouldFallback).toBe(true);
  });
});
