import { InjectionDetector } from "./injection-detector.js";
import { redactSecrets } from "./secret-scrub.js";

/** Per-string-field cap applied to tool results before they re-enter the model context. */
export const TOOL_RESULT_STRING_CAP = 10_000;
/** Total serialized JSON cap for one tool result (after per-string screening). */
export const TOOL_RESULT_TOTAL_CAP = 24_000;
export const TOOL_RESULT_TOTAL_TRUNCATION_MARKER = "[truncated: tool result exceeded cap]";

export interface ScreenFlag {
  tool?: string;
  path: string;
  patterns: string[];
  truncated: boolean;
}

export interface ScreenedResult {
  value: unknown;
  flags: ScreenFlag[];
}

/**
 * Screens an untrusted tool result before it is handed back to the model.
 * Every string field is capped at `cap` chars, run through the injection
 * detector (detected instruction patterns are replaced with the sanitized
 * form), and run through the secret scrubber (secret-shaped spans are
 * replaced with "[redacted]") so a poisoned post/page cannot smuggle a fake
 * key into context. Each detection is returned as a flag so the caller can
 * record it in the evidence bundle. Tool output is data, never instructions.
 */
export function screenToolResult(
  detector: InjectionDetector,
  value: unknown,
  opts?: { cap?: number; tool?: string; sanitize?: boolean },
): ScreenedResult {
  const cap = opts?.cap ?? TOOL_RESULT_STRING_CAP;
  const tool = opts?.tool;
  const flags: ScreenFlag[] = [];

  const walk = (v: unknown, path: string): unknown => {
    if (typeof v === "string") {
      let s = v;
      let truncated = false;
      if (s.length > cap) {
        s = `${s.slice(0, cap)}...[truncated]`;
        truncated = true;
      }
      const d = detector.detect(s, undefined, { sanitize: opts?.sanitize ?? true });
      const patterns = [...d.patterns];
      if (d.detected) s = d.sanitized;
      const redacted = redactSecrets(s);
      if (redacted.hits.length) {
        s = redacted.text;
        patterns.push(...redacted.hits.map((h) => `secret:${h.rule}`));
      }
      if (patterns.length || truncated) {
        flags.push({ tool, path, patterns, truncated });
      }
      return s;
    }
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${path}[${i}]`));
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        out[k] = walk(x, path ? `${path}.${k}` : k);
      }
      return out;
    }
    return v;
  };

  return capSerializedSize(walk(value, ""), flags, TOOL_RESULT_TOTAL_CAP);
}

function truncateArraysStructurally(value: unknown, cap: number): unknown | null {
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      const candidate = [...out, item, TOOL_RESULT_TOTAL_TRUNCATION_MARKER];
      if (JSON.stringify(candidate).length > cap) break;
      out.push(item);
    }
    const finalArr = [...out, TOOL_RESULT_TOTAL_TRUNCATION_MARKER];
    return JSON.stringify(finalArr).length <= cap ? finalArr : null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const arrayKeys = Object.keys(record).filter((k) => Array.isArray(record[k]) && (record[k] as unknown[]).length > 0);
  if (arrayKeys.length === 0) return null;

  const clone: Record<string, unknown> = { ...record, truncated: true, truncation_note: TOOL_RESULT_TOTAL_TRUNCATION_MARKER };
  for (const key of arrayKeys) {
    clone[key] = [...(record[key] as unknown[])];
  }
  while (JSON.stringify(clone).length > cap) {
    let largestKey: string | null = null;
    let largestLen = 0;
    for (const key of arrayKeys) {
      const arr = clone[key] as unknown[];
      if (arr.length > largestLen) {
        largestLen = arr.length;
        largestKey = key;
      }
    }
    if (!largestKey || largestLen === 0) break;
    const arr = clone[largestKey] as unknown[];
    const step = Math.max(1, Math.floor(arr.length / 4));
    arr.splice(arr.length - step, step);
  }
  return JSON.stringify(clone).length <= cap ? clone : null;
}

function capSerializedSize(value: unknown, flags: ScreenFlag[], cap: number): ScreenedResult {
  const json = JSON.stringify(value);
  if (json.length <= cap) return { value, flags };
  flags.push({ path: "$", patterns: [], truncated: true });
  const structural = truncateArraysStructurally(value, cap);
  if (structural !== null) return { value: structural, flags };
  const cut = Math.max(0, cap - TOOL_RESULT_TOTAL_TRUNCATION_MARKER.length - 1);
  const preview = `${json.slice(0, cut)}\n${TOOL_RESULT_TOTAL_TRUNCATION_MARKER}`;
  return { value: preview, flags };
}
