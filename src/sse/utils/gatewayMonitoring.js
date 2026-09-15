import { randomUUID } from "node:crypto";

const MAX_FIELD_LENGTH = 256;

function boundedText(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).replace(/[\r\n]/g, "").trim();
  return text ? text.slice(0, MAX_FIELD_LENGTH) : null;
}

function readHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return boundedText(headers.get(name));
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return boundedText(value);
  }
  return null;
}

export function createGatewayMonitoringContext(headers) {
  return {
    correlationId: readHeader(headers, "x-correlation-id") || randomUUID(),
    keyAlias: readHeader(headers, "x-llm-key-alias"),
    teamAlias: readHeader(headers, "x-llm-team-alias"),
    combo: null,
    attempt: 1,
  };
}

export function buildGatewayAttemptLog(
  {
    monitoring,
    provider,
    model,
    account,
    accountAttempt,
    status,
    success,
    startTime,
  },
  endTime = Date.now()
) {
  const safeStatus = Number.isFinite(status) ? status : 500;
  return {
    event: "llm_gateway.router_attempt",
    router: "ninerouter",
    correlation_id: boundedText(monitoring?.correlationId),
    key_alias: boundedText(monitoring?.keyAlias),
    team_alias: boundedText(monitoring?.teamAlias),
    combo: boundedText(monitoring?.combo),
    attempt: Number.isInteger(monitoring?.attempt) ? monitoring.attempt : 1,
    account_attempt: Number.isInteger(accountAttempt) ? accountAttempt : 1,
    provider: boundedText(provider),
    model: boundedText(model),
    account: boundedText(account),
    status: safeStatus,
    outcome: success && safeStatus >= 200 && safeStatus < 400 ? "success" : "failure",
    latency_ms: Math.max(0, endTime - startTime),
  };
}

export function emitGatewayAttempt(event) {
  console.log(JSON.stringify(event));
}
