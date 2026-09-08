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

/** Only this host may receive universal-tag PUTs from the resources publisher. */
export const STAGING_HOMESERVER_HOST = "homeserver.staging.pubky.app";

/** Staging homeserver public key (homeserver.staging.pubky.app). */
export const STAGING_HOMESERVER_PK = "ufibwbmed6jeq9k4p583go95wofakh9fwpp4k734trq79pd9u1uy";

/** Checked-in public key for the staging resource pilot identity. */
export const RESOURCE_PILOT_BOT_PK = "ui8nw8s9do7u9k9qts4cbup9ry6agz3wxmr734ddhk6jb6zcubso";

export function hostnameFromResourceHost(urlOrHost: string): string {
  const raw = urlOrHost.trim().toLowerCase();
  if (!raw) throw new Error("resource homeserver host is empty");
  try {
    const parsed = new URL(raw.includes("://") ? raw : `https://${raw}`);
    return parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    throw new Error(`invalid resource homeserver host: ${urlOrHost}`);
  }
}

/**
 * Fail closed before any homeserver call: production Pubky hosts are never
 * reachable from the external-resource publisher.
 */
export function assertStagingResourceHomeserverHost(urlOrHost: string): void {
  const host = hostnameFromResourceHost(urlOrHost);
  if (host !== STAGING_HOMESERVER_HOST) {
    throw new Error(`resource egress refused: host '${host}' is not the staging homeserver`);
  }
}

/**
 * Fail closed in resource publish mode: JEB_HOMESERVER and the session's
 * resolved homeserver public key must be the staging homeserver.
 */
export function assertStagingHomeserverPk(pk: string): void {
  const value = pk.trim().toLowerCase();
  if (!value) throw new Error("resource egress refused: homeserver public key is missing");
  if (value !== STAGING_HOMESERVER_PK) {
    throw new Error("resource egress refused: homeserver public key is not the staging homeserver");
  }
}
