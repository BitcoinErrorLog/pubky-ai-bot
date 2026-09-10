/**
 * Bounded failure vocabulary for the resource publisher.
 *
 * Nothing derived from a thrown object may reach a log line, a manifest row,
 * or CLI JSON: an SDK error can carry a request URL, a header, or an
 * authorization URL, and an error from the model provider can echo the prompt.
 * Every sink maps its error to one of these codes instead.
 */
export const RESOURCE_ERROR_CODES = [
  "auth_failed",
  "capability_refused",
  "config_refused",
  "database_failed",
  "homeserver_conflict",
  "homeserver_unavailable",
  "input_invalid",
  "metering_missing",
  "model_failed",
  "nexus_unavailable",
  "overlap_refused",
  "plan_consumed",
  "plan_drift",
  "readback_failed",
  "spend_cap_exceeded",
  "timeout",
  "unknown_failure",
] as const;

export type ResourceErrorCode = (typeof RESOURCE_ERROR_CODES)[number];

const CODE_SET: ReadonlySet<string> = new Set(RESOURCE_ERROR_CODES);

/** An error that already carries a bounded code, so sinks need not classify it. */
export class CodedResourceError extends Error {
  readonly code: ResourceErrorCode;

  constructor(code: ResourceErrorCode, message: string = code) {
    super(message);
    this.name = "CodedResourceError";
    this.code = code;
  }
}

export function isResourceErrorCode(value: unknown): value is ResourceErrorCode {
  return typeof value === "string" && CODE_SET.has(value);
}

/**
 * Classify by structure, never by substring: matching on message text would
 * mean the untrusted message decided the code, and any unmatched message would
 * still have to be discarded. Unrecognized shapes become `unknown_failure`.
 */
export function resourceErrorCode(error: unknown, fallback: ResourceErrorCode = "unknown_failure"): ResourceErrorCode {
  if (error instanceof CodedResourceError) return error.code;
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (isResourceErrorCode(code)) return code;
    if (error instanceof Error && error.name === "AbortError") return "timeout";
    if (typeof code === "string") {
      // Node network/DNS errno values are a fixed, non-secret vocabulary.
      if (code === "ETIMEDOUT" || code === "ABORT_ERR") return "timeout";
      if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "ECONNRESET" || code === "EAI_AGAIN") {
        return "homeserver_unavailable";
      }
    }
  }
  return fallback;
}
