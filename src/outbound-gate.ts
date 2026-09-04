/**
 * Outbound gate: the single deterministic check every text PUT under the bot
 * key must pass — the publisher (src/publish.ts), the operator scripts
 * (scripts/post.ts, scripts/profile.ts), and the red-team oracle all call
 * scanOutboundText, so the eval measures exactly what production enforces.
 *
 * It is the secret scrubber (scanForSecrets) plus a prompt-echo rule:
 * verbatim regurgitation of the system prompt or the security addendum is
 * declined deterministically (rule id `prompt_echo`), not just resisted at
 * the model layer.
 */
import { systemPrompt } from "./compose.js";
import { SECURITY_PROMPT_ADDENDUM } from "./extraction-guard.js";
import { scanForSecrets, type ScanResult, type ScrubHit } from "./secret-scrub.js";
import { normalizeForScan } from "./text-normalize.js";

/** Minimum verbatim shingle length that counts as a prompt echo. */
export const PROMPT_ECHO_SHINGLE = 48;

let cachedShingles: string[] | null = null;

/**
 * Every PROMPT_ECHO_SHINGLE-char window of the normalized system prompt and
 * security addendum. Normalization: NFKC + zero-width strip (shared) and
 * whitespace runs collapsed to one space, so line wrapping does not evade
 * the comparison. Case is preserved — the check is verbatim.
 */
function promptShingles(): string[] {
  if (cachedShingles) return cachedShingles;
  const collapse = (s: string) => normalizeForScan(s).replace(/\s+/g, " ");
  const sources = [collapse(systemPrompt()), collapse(SECURITY_PROMPT_ADDENDUM)];
  const out: string[] = [];
  for (const src of sources) {
    for (let i = 0; i + PROMPT_ECHO_SHINGLE <= src.length; i++) {
      out.push(src.slice(i, i + PROMPT_ECHO_SHINGLE));
    }
  }
  cachedShingles = out;
  return out;
}

/** True when the text contains any >=48-char verbatim shingle of the prompts. */
export function containsPromptEcho(text: string): boolean {
  if (!text) return false;
  const t = normalizeForScan(text).replace(/\s+/g, " ");
  for (const shingle of promptShingles()) {
    if (t.includes(shingle)) return true;
  }
  return false;
}

/**
 * The production outbound gate: secret-scrub rules plus `prompt_echo`.
 * `opts.env` overrides the env whose configured secret values and key
 * material are matched; defaults to `process.env`.
 */
export function scanOutboundText(text: string, opts?: { env?: NodeJS.ProcessEnv }): ScanResult {
  const scan = scanForSecrets(text, opts);
  if (!containsPromptEcho(text)) return scan;
  const hits: ScrubHit[] = [...scan.hits, { rule: "prompt_echo" }];
  return { clean: false, hits };
}

/**
 * Throws when the text would trip the outbound gate. For operator tooling
 * where refusing beats publishing a decline. Rule ids only, never text.
 */
export function assertOutboundClean(text: string, opts?: { env?: NodeJS.ProcessEnv }): void {
  const scan = scanOutboundText(text, opts);
  if (!scan.clean) {
    throw new Error(`outbound gate refused text: ${scan.hits.map((h) => h.rule).join(", ")}`);
  }
}
