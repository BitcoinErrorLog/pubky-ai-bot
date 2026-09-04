/**
 * Secret scrubber: the publisher-side last gate before any bytes leave under
 * the bot key (scanForSecrets), and the same rule set plus cheap shape rules
 * applied to untrusted tool results before they re-enter the model context
 * (redactSecrets via src/tool-screen.ts).
 *
 * Two rule tiers, deliberately:
 *
 * - OUTBOUND GATE (scanForSecrets): value-matched rules only where a shape
 *   alone cannot distinguish a secret from legitimate content. The signing
 *   key is matched by VALUE in every enumerable encoding (hex — contiguous,
 *   0x-prefixed, embedded in longer runs, or separated by short non-hex
 *   runs, found via compacted-run containment; base64 std/url with and
 *   without padding, base32 RFC4648 upper/lower, z-base-32 — found as plain
 *   substrings, so URL- or punctuation-embedded forms match too; bech32/
 *   bech32m are NOT covered: no implementation is available in the
 *   dependency tree), configured env secrets are matched as substrings (plus
 *   any contiguous >=16-char fragment), and mnemonics are detected two ways
 *   (see scanBip39): the CONFIGURED phrase by ordered-subsequence value
 *   match (zero false positives, filler-proof), and unknown phrases ONLY as
 *   contiguous, line-bounded, checksum-valid runs — the 2026-09-04
 *   production false positive (filler-skipping windows over wordlist-heavy
 *   prose, 4-bit checksum) is why the shape rule is this narrow. Shape
 *   rules that would false-positive on exactly the content this bot exists
 *   to discuss (64-hex txids/pubkeys/digests, RFC example bearer tokens)
 *   are NOT in this tier.
 *
 * - TOOL RESULTS (redactSecrets): everything above PLUS the cheap shape
 *   rules `hex64` and `bearer_token`. Redaction is cheap there and false
 *   positives cost little, so a poisoned post/page cannot smuggle a fake key
 *   into context. Shape-based redaction is intentionally tool-results-only.
 *
 * All scans run on normalized text (NFKC + zero-width/format-char stripping,
 * see src/text-normalize.ts); redactSecrets returns the normalized text with
 * "[redacted]" spans. Detections are reported by rule id ONLY — the matched
 * text is never returned, logged, or stored.
 */
import { entropyToMnemonic, mnemonicToSeedSync, validateMnemonic, wordlists } from "bip39";
import { base32Encode, zbase32Encode } from "../base32.js";
import { normalizeForScan } from "../text-normalize.js";

export const SECRET_SCRUB_RULES = [
  "hex64",
  "key_material",
  "bip39",
  "api_token",
  "bearer_token",
  "credentialed_url",
  "admin_header",
  "env_secret",
  "env_assignment",
  "signup_token",
  "prompt_echo",
] as const;

export type SecretScrubRule = (typeof SECRET_SCRUB_RULES)[number];

export interface ScrubHit {
  rule: SecretScrubRule;
}

export interface ScanResult {
  clean: boolean;
  hits: ScrubHit[];
}

/** Deterministic reply published (or returned) instead of any scrubbed text. */
export const SECRET_DECLINE_REPLY =
  "I don't share configuration or credentials, mine or anyone's.";

const REDACTED = "[redacted]";

const API_TOKEN =
  /\b(?:sk-[A-Za-z0-9_-]{8,}|sk_live_[A-Za-z0-9]{8,}|sk_test_[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{8,}|gho_[A-Za-z0-9]{8,}|ghu_[A-Za-z0-9]{8,}|ghs_[A-Za-z0-9]{8,}|ghr_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{16})\b/g;

/** Tool-results-only shape rule: RFC example bearer tokens must pass the outbound gate. */
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;

const CREDENTIALED_URL = /\b(?:postgres(?:ql)?|redis|mysql|mongodb(?:\+srv)?|amqp(?:s)?|mssql):\/\/[^\s/?#@]*:[^\s/?#@]+@/gi;

/** Only fires on an actual header assignment, never the bare header name. */
const ADMIN_HEADER = /X-Admin-Password\s*:\s*\S+/gi;

/** Hex chars possibly separated by short non-hex runs (spaces, dashes, commas). */
const HEX_RUN = /(?:0[xX])?[0-9a-fA-F]+(?:[^0-9a-zA-Z]{1,8}[0-9a-fA-F]+)*/g;
/** Cap on compacted hex per run, bounding the 64-char sliding-window work. */
const HEX_RUN_COMPACT_CAP = 512;

const BIP39_RUN_SIZES = [12, 15, 18, 21, 24] as const;

/** Separators allowed INSIDE a contiguous mnemonic run: whitespace, commas, line breaks. */
const BIP39_RUN_GAP = /^[\s,]+$/;
/**
 * A candidate run whose neighbour on a side is a bare word attached by
 * horizontal whitespace/commas only is embedded in a sentence and is NOT a
 * shape candidate. Newlines, punctuation, and start/end of text are
 * legitimate boundaries — a real phrase is quoted, listed, or on its own
 * line, it does not flow out of a clause.
 */
const BIP39_EMBEDDED_GAP = /^[ \t,]*$/;

/** Env vars whose literal values must never appear in outbound text. */
const SECRET_ENV_NAMES = [
  "PUBKY_BOT_SECRET_KEY_HEX",
  "PUBKY_BOT_MNEMONIC",
  "JEB_SIGNUP_TOKEN",
  "ADMIN_TOKEN",
  "JEB_MODEL_API_KEY",
  "JEB_BRAVE_API_KEY",
  "JEB_EMBED_API_KEY",
  "DATABASE_URL",
] as const;

/**
 * Shorter values are too likely to collide with ordinary prose; a value
 * below this length is not protected at all. Documented tradeoff.
 */
export const ENV_SECRET_MIN_LEN = 8;

/**
 * Any contiguous fragment of a configured value at least this long is also
 * matched (partial-output trick). Shorter fragments are inherently
 * uncatchable without false positives on prose — documented limitation.
 */
export const ENV_SECRET_PARTIAL_MIN_LEN = 16;

interface ConfiguredSecret {
  rule: "env_secret" | "signup_token";
  raw: string;
}

/**
 * Configured secret values from the given env (default: this process's env).
 * Raw values are retained in module memory only for substring matching and
 * redaction spans; they never leave the module.
 */
function configuredSecrets(env: NodeJS.ProcessEnv): ConfiguredSecret[] {
  const out: ConfiguredSecret[] = [];
  const seen = new Set<string>();
  const names = new Set<string>(SECRET_ENV_NAMES);
  for (const k of Object.keys(env)) {
    if (k.startsWith("PUBKY_BOT_")) names.add(k);
  }
  for (const name of names) {
    const raw = env[name]?.trim();
    if (!raw || raw.length < ENV_SECRET_MIN_LEN || seen.has(raw)) continue;
    seen.add(raw);
    out.push({ rule: name === "JEB_SIGNUP_TOKEN" ? "signup_token" : "env_secret", raw });
  }
  return out;
}

/**
 * Raw key bytes derivable from the env: the signing key hex, and the seed's
 * first 32 bytes when only a mnemonic is configured.
 */
function keyByteArrays(env: NodeJS.ProcessEnv): Buffer[] {
  const out: Buffer[] = [];
  const hex = env.PUBKY_BOT_SECRET_KEY_HEX?.trim();
  if (hex && /^[0-9a-fA-F]{64}$/.test(hex)) out.push(Buffer.from(hex, "hex"));
  const mnemonic = env.PUBKY_BOT_MNEMONIC?.trim();
  if (mnemonic && validateMnemonic(mnemonic)) {
    out.push(Buffer.from(mnemonicToSeedSync(mnemonic).subarray(0, 32)));
  }
  return out;
}

interface KeyForms {
  /** Lowercase hex of the key bytes. */
  hex: string;
  /** Every other enumerable encoding of the key bytes. */
  encoded: string[];
}

/**
 * Every enumerable encoding of the configured key material, as plain
 * strings for substring matching (constant-time comparison buys nothing for
 * defensive search). Encodings of a known value are finite; shape rules for
 * arbitrary encodings are not. bech32/bech32m are not covered (no
 * implementation in the dependency tree) — documented in the hardening
 * report.
 */
function keyEncodingForms(keys: Buffer[]): KeyForms[] {
  return keys.map((kb) => {
    const hex = kb.toString("hex");
    const b64 = kb.toString("base64");
    const b64url = kb.toString("base64url");
    const b32 = base32Encode(kb);
    return {
      hex,
      encoded: [
        hex.toUpperCase(),
        b64,
        b64.replace(/=+$/, ""),
        b64url,
        b64url.replace(/=+$/, ""),
        b32,
        b32.replace(/=+$/, ""),
        b32.toLowerCase(),
        b32.toLowerCase().replace(/=+$/, ""),
        zbase32Encode(kb),
      ],
    };
  });
}

interface Span {
  start: number;
  end: number;
}

interface InternalHit {
  rule: SecretScrubRule;
  spans: Span[];
}

function scanRegex(text: string, rx: RegExp, rule: SecretScrubRule): InternalHit | null {
  const spans: Span[] = [];
  rx.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(text))) {
    spans.push({ start: m.index, end: m.index + m[0].length });
    if (m[0].length === 0) rx.lastIndex += 1;
  }
  return spans.length ? { rule, spans } : null;
}

/** Tool-results-only shape rule: any 64-hex span, contiguous or split. */
function scanHex64Shape(text: string): InternalHit | null {
  const spans: Span[] = [];
  // Contiguous 64-hex segments.
  const CONTIG = /[0-9a-fA-F]+/g;
  let m: RegExpExecArray | null;
  while ((m = CONTIG.exec(text))) {
    if (m[0].length === 64) spans.push({ start: m.index, end: m.index + 64 });
  }
  // Split forms: hex groups separated by short non-hex runs, 64 hex in total.
  HEX_RUN.lastIndex = 0;
  while ((m = HEX_RUN.exec(text))) {
    const s = m[0];
    if (!/[^0-9a-fA-F]/.test(s)) continue; // contiguous case handled above
    const prefix = /^0[xX]/.test(s) ? 2 : 0;
    const compact = s.slice(prefix).replace(/[^0-9a-fA-F]/g, "");
    if (compact.length === 64) spans.push({ start: m.index, end: m.index + s.length });
  }
  return spans.length ? { rule: "hex64", spans } : null;
}

/**
 * Value-match for the configured key material: every enumerable encoding is
 * searched as a plain substring (so URL- or punctuation-embedded forms
 * match), and hex additionally via compacted-run containment (so
 * separator-split, 0x-prefixed, and longer-run-embedded forms match).
 */
function scanKeyMaterial(text: string, keys: KeyForms[]): InternalHit | null {
  if (keys.length === 0) return null;
  const spans: Span[] = [];
  const lower = text.toLowerCase();
  const pushAll = (haystack: string, needle: string) => {
    let from = 0;
    for (;;) {
      const idx = haystack.indexOf(needle, from);
      if (idx < 0) break;
      spans.push({ start: idx, end: idx + needle.length });
      from = idx + 1;
    }
  };
  for (const key of keys) {
    pushAll(lower, key.hex);
    for (const form of key.encoded) pushAll(text, form);
    // Hex with separators: compact every run and check containment.
    HEX_RUN.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = HEX_RUN.exec(text))) {
      const s = m[0];
      const prefix = /^0[xX]/.test(s) ? 2 : 0;
      const compact = s
        .slice(prefix)
        .replace(/[^0-9a-fA-F]/g, "")
        .toLowerCase()
        .slice(0, HEX_RUN_COMPACT_CAP);
      if (compact.includes(key.hex)) spans.push({ start: m.index, end: m.index + s.length });
    }
  }
  return spans.length ? { rule: "key_material", spans } : null;
}

interface Bip39Wordlist {
  /**
   * NFKC-normalized entries for run detection. Scan text is NFKC
   * (src/text-normalize.ts) but bip39 ships the Spanish/French/Korean (and
   * parts of the Italian/Portuguese/Czech) wordlists in NFKD, so membership
   * must be tested against NFKC forms or those lists never match.
   */
  set: ReadonlySet<string>;
  /** NFKC form -> raw shipped spelling, for checksum validation. */
  raw: ReadonlyMap<string, string>;
  /** Raw shipped list, passed to validateMnemonic. */
  list: string[];
}

let cachedWordlists: Bip39Wordlist[] | null = null;

/** Every BIP39 wordlist the bip39 package ships (all languages). */
function allBip39Wordlists(): Bip39Wordlist[] {
  if (!cachedWordlists) {
    cachedWordlists = Object.values(wordlists).map((list) => {
      const raw = new Map<string, string>();
      for (const w of list) raw.set(w.normalize("NFKC"), w);
      return { set: new Set(raw.keys()), raw, list };
    });
  }
  return cachedWordlists;
}

interface WordToken {
  /** Lowercased word. */
  word: string;
  index: number;
  end: number;
}

/** Letter tokens of the text with their spans, lowercased for comparison. */
function wordTokens(text: string): WordToken[] {
  const out: WordToken[] = [];
  const rx = /[\p{L}\p{M}]+/gu;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(text))) {
    out.push({ word: m[0].toLowerCase(), index: m.index, end: m.index + m[0].length });
  }
  return out;
}

/**
 * The exact mnemonic word sequences this deployment holds:
 * PUBKY_BOT_MNEMONIC itself, and the 24-word phrase whose entropy is
 * PUBKY_BOT_SECRET_KEY_HEX — a 32-byte secret key IS valid BIP39 entropy, so
 * the key has a mnemonic form an attacker could exfiltrate in words instead
 * of hex. Word sequences never leave the module; detections report the rule
 * id only.
 */
function knownMnemonics(env: NodeJS.ProcessEnv): string[][] {
  const out: string[][] = [];
  const seen = new Set<string>();
  const push = (phrase: string | undefined) => {
    const m = phrase?.trim().toLowerCase().replace(/\s+/g, " ");
    if (!m || seen.has(m) || !validateMnemonic(m)) return;
    seen.add(m);
    out.push(m.split(" "));
  };
  push(env.PUBKY_BOT_MNEMONIC);
  const hex = env.PUBKY_BOT_SECRET_KEY_HEX?.trim();
  if (hex && /^[0-9a-fA-F]{64}$/.test(hex)) push(entropyToMnemonic(Buffer.from(hex, "hex")));
  return out;
}

/**
 * Known-value match: the configured phrase detected as an ORDERED
 * SUBSEQUENCE of the text's word tokens — filler words between the mnemonic
 * words cannot evade it, and nothing but the real phrase can complete the
 * sequence, so this tier has zero shape false positives. As with the env
 * value rules, comparison is plain defensive search (constant-time buys
 * nothing here); the words are never logged.
 */
function scanKnownMnemonics(tokens: WordToken[], known: string[][]): Span[] {
  const spans: Span[] = [];
  for (const seq of known) {
    if (tokens.length < seq.length) continue;
    let k = 0;
    let first = -1;
    for (const t of tokens) {
      if (t.word !== seq[k]) continue;
      if (k === 0) first = t.index;
      k += 1;
      if (k === seq.length) {
        spans.push({ start: first, end: t.end });
        k = 0;
      }
    }
  }
  return spans;
}

/**
 * Shape match for mnemonics this deployment does NOT hold (e.g. a poisoned
 * tool result smuggling someone else's seed phrase). Deliberately narrow —
 * the 2026-09-04 production false positive showed that filler-skipping
 * windows over wordlist-heavy prose pass the 4-bit 12-word checksum far too
 * often (~1/16 per window). A candidate must therefore be:
 *
 * - CONTIGUOUS: consecutive wordlist words separated only by whitespace,
 *   commas, or line breaks — no non-wordlist word in between;
 * - EXACT LENGTH: the whole run is exactly 12/15/18/21/24 words (no sliding
 *   windows over longer runs);
 * - LINE-BOUNDED: the run is the whole text/line or bounded by punctuation
 *   or a newline on both sides, never a word flowing straight into or out
 *   of it (not embedded in a sentence);
 * - CHECKSUM-VALID, forward or reversed (the "say it backwards" trick),
 *   against any shipped wordlist. Run detection compares NFKC-normalized
 *   wordlist entries (scan text is NFKC); candidates are mapped back to the
 *   raw shipped spelling before validateMnemonic, so the NFKD-shipped lists
 *   (Spanish, French, Korean, accented Italian/Portuguese/Czech) fire too.
 *
 * Residual FP: a line that is exactly 12/15/18/21/24 wordlist words AND
 * checksum-valid fires by construction (~2^-4 for a random 12-word line) —
 * such lines do not occur in natural prose (quantified by the 200-paragraph
 * synthetic corpus and the realistic-reply corpus in secret-scrub.test.ts,
 * both asserting zero hits).
 * Limitation: word extraction is letter-based, so wordlists for languages
 * without spaces (e.g. Japanese) are only detected when space-separated.
 */
function scanBip39Shape(text: string, tokens: WordToken[]): Span[] {
  const spans: Span[] = [];
  for (const wl of allBip39Wordlists()) {
    let run: number[] = [];
    const flush = () => {
      if ((BIP39_RUN_SIZES as readonly number[]).includes(run.length)) {
        const first = tokens[run[0]];
        const last = tokens[run[run.length - 1]];
        const before = text.slice(run[0] === 0 ? 0 : tokens[run[0] - 1].end, first.index);
        const after = text.slice(last.end, run[run.length - 1] === tokens.length - 1 ? text.length : tokens[run[run.length - 1] + 1].index);
        const embeddedBefore = run[0] > 0 && BIP39_EMBEDDED_GAP.test(before);
        const embeddedAfter = run[run.length - 1] < tokens.length - 1 && BIP39_EMBEDDED_GAP.test(after);
        if (!embeddedBefore && !embeddedAfter) {
          // Map the NFKC scan tokens back to the raw shipped spelling before
          // checksum validation against the raw list (NFKD-shipped lists —
          // Spanish/French/Korean — would otherwise never validate).
          const words = run.map((k) => wl.raw.get(tokens[k].word) ?? tokens[k].word.normalize("NFKD"));
          if (
            validateMnemonic(words.join(" "), wl.list) ||
            validateMnemonic([...words].reverse().join(" "), wl.list)
          ) {
            spans.push({ start: first.index, end: last.end });
          }
        }
      }
      run = [];
    };
    for (let i = 0; i < tokens.length; i++) {
      if (!wl.set.has(tokens[i].word)) {
        flush();
      } else if (run.length > 0 && BIP39_RUN_GAP.test(text.slice(tokens[i - 1].end, tokens[i].index))) {
        run.push(i);
      } else {
        flush();
        run = [i];
      }
    }
    flush();
  }
  return spans;
}

/**
 * Mnemonic detection, rule id "bip39": the configured phrase by
 * filler-proof value match (scanKnownMnemonics), and unknown phrases by the
 * narrow contiguous/line-bounded shape match (scanBip39Shape).
 */
function scanBip39(text: string, known: string[][]): InternalHit | null {
  const tokens = wordTokens(text);
  if (tokens.length < 12) return null;
  const spans = [...scanKnownMnemonics(tokens, known), ...scanBip39Shape(text, tokens)];
  return spans.length ? { rule: "bip39", spans } : null;
}

interface DerivedKeyMaterial {
  keyForms: KeyForms[];
  mnemonics: string[][];
}

/**
 * Deriving key material from the env runs validateMnemonic and a 2048-round
 * PBKDF2 (mnemonicToSeedSync) — ~12 ms — so it is cached per env object and
 * reused across scans. The fingerprint is the raw key-material inputs; any
 * change to them (or a fresh env object) invalidates the cache entry.
 */
const derivedKeyCache = new WeakMap<NodeJS.ProcessEnv, { fingerprint: string; material: DerivedKeyMaterial }>();

/** Test-visible count of derivations (incremented on cache miss only). */
export const scrubDerivationStats = { computations: 0 };

function derivedKeyMaterial(env: NodeJS.ProcessEnv): DerivedKeyMaterial {
  const fingerprint = `${env.PUBKY_BOT_SECRET_KEY_HEX ?? ""}\n${env.PUBKY_BOT_MNEMONIC ?? ""}`;
  const hit = derivedKeyCache.get(env);
  if (hit && hit.fingerprint === fingerprint) return hit.material;
  scrubDerivationStats.computations += 1;
  const material: DerivedKeyMaterial = {
    keyForms: keyEncodingForms(keyByteArrays(env)),
    mnemonics: knownMnemonics(env),
  };
  derivedKeyCache.set(env, { fingerprint, material });
  return material;
}

/**
 * Configured values matched as plain substrings of the normalized text
 * (constant-time comparison buys nothing for defensive search), plus any
 * contiguous fragment >= ENV_SECRET_PARTIAL_MIN_LEN (partial-output trick).
 */
function scanEnvSecrets(text: string, secrets: ConfiguredSecret[]): InternalHit[] {
  if (secrets.length === 0) return [];
  const byRule = new Map<"env_secret" | "signup_token", Span[]>();
  const push = (rule: "env_secret" | "signup_token", start: number, end: number) => {
    const spans = byRule.get(rule) ?? [];
    spans.push({ start, end });
    byRule.set(rule, spans);
  };
  for (const secret of secrets) {
    let from = 0;
    for (;;) {
      const idx = text.indexOf(secret.raw, from);
      if (idx < 0) break;
      push(secret.rule, idx, idx + secret.raw.length);
      from = idx + 1;
    }
    if (secret.raw.length >= ENV_SECRET_PARTIAL_MIN_LEN) {
      for (let i = 0; i + ENV_SECRET_PARTIAL_MIN_LEN <= secret.raw.length; i++) {
        const frag = secret.raw.slice(i, i + ENV_SECRET_PARTIAL_MIN_LEN);
        const idx = text.indexOf(frag);
        if (idx >= 0) push(secret.rule, idx, idx + frag.length);
      }
    }
  }
  return [...byRule.entries()].map(([rule, spans]) => ({ rule, spans }));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * `NAME=value` assignments fire ONLY for secret-class names that are actually
 * configured in the env (SECRET_ENV_NAMES plus any configured PUBKY_BOT_*).
 * A reply explaining `set JEB_POLL_MS=3000` or other non-secret settings is
 * legitimate documentation content and must pass; a docs answer assigning a
 * value to one of the bot's own configured secret names is not something the
 * bot ever needs to publish. When no secret-class name is configured the
 * rule cannot fire at all.
 */
function scanEnvAssignment(text: string, env: NodeJS.ProcessEnv): InternalHit | null {
  const names = new Set<string>(SECRET_ENV_NAMES);
  for (const k of Object.keys(env)) {
    if (k.startsWith("PUBKY_BOT_")) names.add(k);
  }
  const configured = [...names].filter((n) => env[n]?.trim());
  if (configured.length === 0) return null;
  const rx = new RegExp(`\\b(?:${configured.map(escapeRegExp).join("|")})\\s*[:=]\\s*\\S+`, "g");
  return scanRegex(text, rx, "env_assignment");
}

export interface ScrubOptions {
  /** Env whose configured secret values, key material, and mnemonic are matched. */
  env?: NodeJS.ProcessEnv;
  /**
   * Rule ids to skip (operator emergency valve). Defaults to the
   * JEB_SCRUB_DISABLED_RULES comma list of the scanned env; unknown ids are
   * ignored. Applies to both the outbound gate and tool-result redaction.
   */
  disabledRules?: ReadonlySet<string>;
}

function disabledScrubRules(opts: ScrubOptions | undefined, env: NodeJS.ProcessEnv): ReadonlySet<string> {
  if (opts?.disabledRules) return opts.disabledRules;
  const out = new Set<string>();
  for (const part of (env.JEB_SCRUB_DISABLED_RULES ?? "").split(",")) {
    const r = part.trim();
    if ((SECRET_SCRUB_RULES as readonly string[]).includes(r)) out.add(r);
  }
  return out;
}

/**
 * `toolResults` adds the cheap shape rules (hex64, bearer_token) that are
 * safe where redaction — not a full-reply decline — is the consequence.
 */
function scanInternal(text: string, opts: ScrubOptions | undefined, toolResults: boolean): InternalHit[] {
  if (!text) return [];
  const t = normalizeForScan(text);
  const env = opts?.env ?? process.env;
  let hits: InternalHit[] = [];
  if (toolResults) {
    const hex = scanHex64Shape(t);
    if (hex) hits.push(hex);
    const bearer = scanRegex(t, BEARER, "bearer_token");
    if (bearer) hits.push(bearer);
  }
  const keyMaterial = derivedKeyMaterial(env);
  const key = scanKeyMaterial(t, keyMaterial.keyForms);
  if (key) hits.push(key);
  const bip39 = scanBip39(t, keyMaterial.mnemonics);
  if (bip39) hits.push(bip39);
  for (const [rx, rule] of [
    [API_TOKEN, "api_token"],
    [CREDENTIALED_URL, "credentialed_url"],
    [ADMIN_HEADER, "admin_header"],
  ] as Array<[RegExp, SecretScrubRule]>) {
    const hit = scanRegex(t, rx, rule);
    if (hit) hits.push(hit);
  }
  const assignment = scanEnvAssignment(t, env);
  if (assignment) hits.push(assignment);
  hits.push(...scanEnvSecrets(t, configuredSecrets(env)));
  const disabled = disabledScrubRules(opts, env);
  if (disabled.size > 0) hits = hits.filter((h) => !disabled.has(h.rule));
  return hits;
}

function toScanResult(internal: InternalHit[]): ScanResult {
  const seen = new Set<SecretScrubRule>();
  const hits: ScrubHit[] = [];
  for (const h of internal) {
    if (seen.has(h.rule)) continue;
    seen.add(h.rule);
    hits.push({ rule: h.rule });
  }
  return { clean: hits.length === 0, hits };
}

/**
 * Outbound gate: scans text about to be published under the bot key.
 * Value-matched rules only — no 64-hex or bearer shape blocking (txids,
 * pubkeys, digests, and RFC example tokens are legitimate content here).
 * `opts.env` overrides the env whose configured secret values and key
 * material are matched; defaults to `process.env`. `opts.disabledRules`
 * overrides the JEB_SCRUB_DISABLED_RULES emergency valve.
 */
export function scanForSecrets(text: string, opts?: ScrubOptions): ScanResult {
  return toScanResult(scanInternal(text, opts, false));
}

/**
 * Replaces every detected secret-shaped span with "[redacted]" and returns
 * the rule ids that fired, on the NORMALIZED text (NFKC, zero-width stripped).
 * Used on untrusted tool results before they reach the model; adds the cheap
 * shape rules (hex64, bearer_token) that are deliberately absent from the
 * outbound gate.
 */
export function redactSecrets(text: string, opts?: ScrubOptions): {
  text: string;
  hits: ScrubHit[];
} {
  const t = normalizeForScan(text);
  const internal = scanInternal(text, opts, true);
  if (internal.length === 0) return { text: t, hits: [] };
  const spans: Span[] = [];
  const seen = new Set<SecretScrubRule>();
  const hits: ScrubHit[] = [];
  for (const h of internal) {
    spans.push(...h.spans);
    if (!seen.has(h.rule)) {
      seen.add(h.rule);
      hits.push({ rule: h.rule });
    }
  }
  spans.sort((a, b) => a.start - b.start);
  const merged: Span[] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else merged.push({ ...s });
  }
  let out = "";
  let cursor = 0;
  for (const s of merged) {
    out += t.slice(cursor, s.start);
    out += REDACTED;
    cursor = s.end;
  }
  out += t.slice(cursor);
  return { text: out, hits };
}

/**
 * Throws when the text would trip the outbound gate. For operator tooling
 * (scripts/post.ts, scripts/profile.ts) where refusing beats publishing a
 * decline. The error names rule ids only, never the matched text.
 */
export function assertNoSecrets(text: string, opts?: ScrubOptions): void {
  const scan = scanForSecrets(text, opts);
  if (!scan.clean) {
    throw new Error(`secret-scrubber refused outbound text: ${scan.hits.map((h) => h.rule).join(", ")}`);
  }
}
