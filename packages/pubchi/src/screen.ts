import { InjectionDetector } from "../bot-kit/security/injection-detector.js";
import { screenToolResult } from "../bot-kit/security/tool-screen.js";

const detector = new InjectionDetector();

/** Tool output is data. Screening cannot change asker or scope. */
export function screenUntrusted(value: unknown, tool?: string): unknown {
  return screenToolResult(detector, value, tool ? { tool } : undefined).value;
}
