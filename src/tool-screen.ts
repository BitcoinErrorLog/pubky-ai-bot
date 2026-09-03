import { InjectionDetector } from "./injection-detector.js";

/** Per-string-field cap applied to tool results before they re-enter the model context. */
export const TOOL_RESULT_STRING_CAP = 10_000;

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
 * Every string field is capped at `cap` chars and run through the injection
 * detector; detected instruction patterns are replaced with the detector's
 * sanitized form and each detection is returned as a flag so the caller can
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
      if (d.detected) {
        flags.push({ tool, path, patterns: d.patterns, truncated });
        return d.sanitized;
      }
      if (truncated) {
        flags.push({ tool, path, patterns: [], truncated: true });
        return s;
      }
      return v;
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

  return { value: walk(value, ""), flags };
}
