import { ERROR_CODES, type ErrorCode } from "../pubchi-schemas/index.js";

/** Schema codes plus Phase 0 service-only codes. Never leak internals. */
export const SERVICE_ERROR_CODES = [
  ...ERROR_CODES,
  "TENANT_NOT_ENROLLED",
  "BUDGET_EXCEEDED",
  "UPSTREAM_UNAVAILABLE",
  "BRAIN_UNAVAILABLE",
] as const;

export type ServiceErrorCode = (typeof SERVICE_ERROR_CODES)[number];

const ALLOWED = new Set<string>(SERVICE_ERROR_CODES);

export function isServiceErrorCode(code: string): code is ServiceErrorCode {
  return ALLOWED.has(code);
}

export function publicError(code: ServiceErrorCode | ErrorCode): { error: ServiceErrorCode } {
  return { error: isServiceErrorCode(code) ? code : "SCHEMA_INVALID" };
}

export function httpStatusFor(code: ServiceErrorCode): number {
  if (code === "TENANT_NOT_ENROLLED") return 404;
  if (code === "BUDGET_EXCEEDED") return 429;
  if (code === "UPSTREAM_UNAVAILABLE" || code === "BRAIN_UNAVAILABLE") return 503;
  return 400;
}
