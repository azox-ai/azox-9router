import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGatewayAttemptLog,
  createGatewayMonitoringContext,
} from "../../src/sse/utils/gatewayMonitoring.js";

test("preserves bounded correlation and alias headers", () => {
    const context = createGatewayMonitoringContext(
      {
        "X-Correlation-Id": "trace-123\nignored",
        "X-Llm-Key-Alias": "zbs-coding-tech-quanlt",
        "X-Llm-Team-Alias": "ZBS Tech - Code",
      }
    );

    assert.deepEqual(context, {
      correlationId: "trace-123ignored",
      keyAlias: "zbs-coding-tech-quanlt",
      teamAlias: "ZBS Tech - Code",
      combo: null,
      attempt: 1,
    });
});

test("builds metadata-only account attempt logs", () => {
    const event = buildGatewayAttemptLog(
      {
        monitoring: {
          correlationId: "trace-123",
          keyAlias: "key-alias",
          teamAlias: "team-alias",
          combo: "combo-name",
          attempt: 2,
        },
        provider: "claude",
        model: "claude-opus-5",
        account: "subscription-1",
        accountAttempt: 3,
        status: 429,
        success: false,
        startTime: 1_000,
      },
      1_718
    );

    assert.deepEqual(event, {
      event: "llm_gateway.router_attempt",
      router: "ninerouter",
      correlation_id: "trace-123",
      key_alias: "key-alias",
      team_alias: "team-alias",
      combo: "combo-name",
      attempt: 2,
      account_attempt: 3,
      provider: "claude",
      model: "claude-opus-5",
      account: "subscription-1",
      status: 429,
      outcome: "failure",
      latency_ms: 718,
    });
});
