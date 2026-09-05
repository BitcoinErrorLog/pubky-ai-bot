import { sanitizeUntrustedDraftText } from "../drafts/finish.js";
import { InjectionDetector } from "../injection-detector.js";
import { screenToolResult } from "../tool-screen.js";
import { FEEDBACK_QUOTE_MAX } from "./types.js";

const detector = new InjectionDetector();

/**
 * Neutralise a user excerpt before it can re-enter a later model prompt.
 * Tool-output screening + draft sanitizer (markdown/pubky/instruction patterns).
 */
const INSTRUCTION_PHRASES = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|directives?)/gi,
  /(you\s+are\s+now|act\s+as|pretend\s+to\s+be)\s+(a|an)\s+\w+/gi,
  /repeat\s+(your|the)\s+(instructions?|prompt|system)/gi,
  /(developer|debug|admin)\s+mode|jailbreak|bypass\s+safety/gi,
  /\[(system|user|assistant|context)\]/gi,
  /<\|(system|user|end)\|>/gi,
];

export function sanitizeFeedbackQuote(raw: string): string {
  const screened = screenToolResult(detector, raw, { cap: FEEDBACK_QUOTE_MAX, tool: "feedback_quote" });
  let text = typeof screened.value === "string" ? screened.value : String(screened.value ?? "");
  for (const rx of INSTRUCTION_PHRASES) text = text.replace(rx, "[filtered]");
  const cleaned = sanitizeUntrustedDraftText(text).slice(0, FEEDBACK_QUOTE_MAX).trim();
  return cleaned || "[filtered]";
}
