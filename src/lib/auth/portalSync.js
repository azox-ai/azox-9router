import { timingSafeEqual } from "node:crypto";

const HEADER_PREFIX = "Bearer ";

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function hasValidPortalSyncToken(request) {
  const expected = process.env.PORTAL_SYNC_TOKEN;
  const authorization = request.headers.get("authorization") || "";
  if (!expected || !authorization.startsWith(HEADER_PREFIX)) return false;
  return safeEqual(authorization.slice(HEADER_PREFIX.length), expected);
}
