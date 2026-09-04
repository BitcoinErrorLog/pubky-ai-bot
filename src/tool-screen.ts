import { InjectionDetector } from "./injection-detector.js";
import { redactSecrets } from "./secret-scrub.js";

/** Per-string-field cap applied to tool results before they re-enter the model context. */
export const TOOL_RESULT_STRING_CAP = 10_000;
/** Total serialized JSON cap for one tool result (after per-string screening). */
export const TOOL_RESULT_TOTAL_CAP = 8_000;
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
  opts?: { cap?: number; tool?: string },
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
      const d = detector.detect(s);
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

function capSerializedSize(value: unknown, flags: ScreenFlag[], cap: number): ScreenedResult {
  const json = JSON.stringify(value);
  if (json.length <= cap) return { value, flags };
  flags.push({ path: "$", patterns: [], truncated: true });
  const cut = Math.max(0, cap - TOOL_RESULT_TOTAL_TRUNCATION_MARKER.length - 1);
  const preview = `${json.slice(0, cut)}\n${TOOL_RESULT_TOTAL_TRUNCATION_MARKER}`;
  return { value: preview, flags };
}
