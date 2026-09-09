import { ERROR_CODES, type ErrorCode } from "../pubchi-schemas/index.js";

/** Schema codes plus Phase 0 service-only codes. Never leak internals. */
export const SERVICE_ERROR_CODES = [
  ...ERROR_CODES,
  "TENANT_NOT_ENROLLED",
  "UNAUTHORIZED",
  "BUDGET_EXCEEDED",
  "RATE_LIMITED",
  "UPSTREAM_UNAVAILABLE",
  "BRAIN_UNAVAILABLE",
  "FEED_DISABLED",
] as const;

export type ServiceErrorCode = (typeof SERVICE_ERROR_CODES)[number];

export const FEED_FAILURE_CAUSES = ["unsupported_intent", "schema", "json_parse"] as const;
export type FeedFailureCause = (typeof FEED_FAILURE_CAUSES)[number];

const ALLOWED = new Set<string>(SERVICE_ERROR_CODES);

export function isServiceErrorCode(code: string): code is ServiceErrorCode {
  return ALLOWED.has(code);
}

export function publicError(code: ServiceErrorCode | ErrorCode): { error: ServiceErrorCode } {
  return { error: isServiceErrorCode(code) ? code : "SCHEMA_INVALID" };
}

/**
 * Authorization failures are 403. The delegation codes never reach the wire
 * verbatim — an unproven device signer always gets the opaque UNAUTHORIZED —
 * but they map consistently in case a future path surfaces one.
 */
const AUTHORIZATION_CODES = new Set<string>([
  "UNAUTHORIZED",
  "DELEGATION_NOT_FOUND",
  "DELEGATION_INVALID",
  "DELEGATION_EXPIRED",
  "DELEGATION_PURPOSE_FORBIDDEN",
  "DELEGATION_OWNER_MISMATCH",
]);

export function httpStatusFor(code: ServiceErrorCode): number {
  if (AUTHORIZATION_CODES.has(code)) return 403;
  if (code === "TENANT_NOT_ENROLLED") return 404;
  if (code === "BUDGET_EXCEEDED" || code === "RATE_LIMITED") return 429;
  if (code === "UPSTREAM_UNAVAILABLE" || code === "BRAIN_UNAVAILABLE" || code === "FEED_DISABLED") return 503;
  return 400;
}
