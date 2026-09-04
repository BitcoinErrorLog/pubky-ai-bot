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
 *   key is matched by VALUE in every enumerable encoding (hex, 0x-prefixed,
 *   embedded in longer hex runs, separated by short non-hex runs, base64
 *   std/url with and without padding, base32 RFC4648, z-base-32 — bech32/
 *   bech32m are NOT covered: no implementation is available in the
 *   dependency tree), configured env secrets are matched as substrings (plus
 *   any contiguous >=16-char fragment), and mnemonics are validated against
 *   the BIP39 checksum. Shape rules that would false-positive on exactly the
 *   content this bot exists to discuss (64-hex txids/pubkeys/digests, RFC
 *   example bearer tokens) are NOT in this tier.
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
import { createHash, timingSafeEqual } from "node:crypto";
import { mnemonicToSeedSync, validateMnemonic, wordlists } from "bip39";
import { base32Encode, zbase32Encode } from "./base32.js";
import { normalizeForScan } from "./text-normalize.js";

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

/** Mirrors the red-team eval oracle: an env name with an attached value. */
const ENV_ASSIGNMENT = /(?:JEB_[A-Z_]+|ADMIN_TOKEN|DATABASE_URL|PUBKY_BOT_[A-Z_]+)\s*[:=]\s*\S+/g;

/** Hex chars possibly separated by short non-hex runs (spaces, dashes, commas). */
const HEX_RUN = /(?:0[xX])?[0-9a-fA-F]+(?:[^0-9a-zA-Z]{1,8}[0-9a-fA-F]+)*/g;
/** Cap on compacted hex per run, bounding the 64-char sliding-window work. */
const HEX_RUN_COMPACT_CAP = 512;

const BIP39_WINDOW_SIZES = [12, 15, 18, 21, 24] as const;

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

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

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

/**
 * sha256 digests of every enumerable encoding of the configured key
 * material. Encodings of a known value are finite; shape rules for arbitrary
 * encodings are not. bech32/bech32m are not covered (no implementation in
 * the dependency tree) — documented in the hardening report.
 */
function keyEncodingDigests(keys: Buffer[]): Buffer[] {
  const digests: Buffer[] = [];
  for (const kb of keys) {
    const hex = kb.toString("hex");
    const b64 = kb.toString("base64");
    const b64url = kb.toString("base64url");
    const b32 = base32Encode(kb);
    const forms = [
      hex,
      hex.toUpperCase(),
      `0x${hex}`,
      `0x${hex.toUpperCase()}`,
      `0X${hex}`,
      `0X${hex.toUpperCase()}`,
      b64,
      b64.replace(/=+$/, ""),
      b64url,
      b64url.replace(/=+$/, ""),
      b32,
      b32.replace(/=+$/, ""),
      b32.toLowerCase(),
      b32.toLowerCase().replace(/=+$/, ""),
      zbase32Encode(kb),
    ];
    for (const f of forms) digests.push(sha256(f));
  }
  return digests;
}

interface Candidate {
  token: string;
  index: number;
  end: number;
}

/**
 * Every 64-char window of every hex run (hex chars separated by short
 * non-hex runs, optional 0x prefix, embedded in longer runs). Value-matching
 * makes generosity free: only equality with the key digest blocks.
 */
function hexCandidates(text: string): Candidate[] {
  const out: Candidate[] = [];
  HEX_RUN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HEX_RUN.exec(text))) {
    const s = m[0];
    const prefix = /^0[xX]/.test(s) ? 2 : 0;
    const compact = s
      .slice(prefix)
      .replace(/[^0-9a-fA-F]/g, "")
      .slice(0, HEX_RUN_COMPACT_CAP);
    if (compact.length < 64) continue;
    for (let i = 0; i + 64 <= compact.length; i++) {
      out.push({ token: compact.slice(i, i + 64), index: m.index, end: m.index + s.length });
    }
  }
  return out;
}

/** Candidate tokens: whitespace-separated, stripped of surrounding punctuation. */
function candidateTokens(text: string): Candidate[] {
  const out: Candidate[] = [];
  const rx = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(text))) {
    const rawTok = m[0];
    const trimmed = rawTok.replace(/^[\s"'`([{<]+/, "").replace(/[\s"'`)\]}>.,;:!?]+$/, "");
    if (trimmed.length < ENV_SECRET_MIN_LEN) continue;
    const offset = rawTok.indexOf(trimmed);
    out.push({ token: trimmed, index: m.index + offset, end: m.index + offset + trimmed.length });
  }
  return out;
}

function hashEquals(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
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
 * Value-match for the configured key material: hash every hex window and
 * every token, compare against digests of the key's enumerable encodings.
 */
function scanKeyMaterial(text: string, digests: Buffer[]): InternalHit | null {
  if (digests.length === 0) return null;
  const spans: Span[] = [];
  for (const cand of [...hexCandidates(text), ...candidateTokens(text)]) {
    const h = sha256(cand.token);
    for (const d of digests) {
      if (hashEquals(h, d)) {
        spans.push({ start: cand.index, end: cand.end });
        break;
      }
    }
  }
  return spans.length ? { rule: "key_material", spans } : null;
}

interface Bip39Wordlist {
  set: ReadonlySet<string>;
  list: string[];
}

let cachedWordlists: Bip39Wordlist[] | null = null;

/** Every BIP39 wordlist the bip39 package ships (all languages). */
function allBip39Wordlists(): Bip39Wordlist[] {
  if (!cachedWordlists) {
    cachedWordlists = Object.values(wordlists).map((list) => ({ set: new Set(list), list }));
  }
  return cachedWordlists;
}

/**
 * Mnemonic detection: extract wordlist words IN ORDER (filler words between
 * them are ignored) and validate every candidate 12/15/18/21/24-word
 * subsequence against the BIP39 checksum, for every shipped wordlist. A real
 * mnemonic passes checksum; random wordlist prose essentially never does, so
 * interleaving filler no longer helps and the FP risk stays near zero.
 * Limitation: word extraction is letter-based, so wordlists for languages
 * without spaces (e.g. Japanese) are only detected when space-separated.
 */
function scanBip39(text: string): InternalHit | null {
  const words: Array<{ word: string; index: number; end: number }> = [];
  const rx = /[\p{L}\p{M}]+/gu;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(text))) {
    words.push({ word: m[0], index: m.index, end: m.index + m[0].length });
  }
  if (words.length < 12) return null;
  const spans: Span[] = [];
  for (const wl of allBip39Wordlists()) {
    const filtered = words.filter((w) => wl.set.has(w.word));
    if (filtered.length < 12) continue;
    for (const size of BIP39_WINDOW_SIZES) {
      if (filtered.length < size) continue;
      for (let i = 0; i + size <= filtered.length; i++) {
        const phrase = filtered
          .slice(i, i + size)
          .map((w) => w.word)
          .join(" ");
        if (validateMnemonic(phrase, wl.list)) {
          spans.push({ start: filtered[i].index, end: filtered[i + size - 1].end });
        }
      }
    }
  }
  return spans.length ? { rule: "bip39", spans } : null;
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

/**
 * `toolResults` adds the cheap shape rules (hex64, bearer_token) that are
 * safe where redaction — not a full-reply decline — is the consequence.
 */
function scanInternal(text: string, opts: { env?: NodeJS.ProcessEnv } | undefined, toolResults: boolean): InternalHit[] {
  if (!text) return [];
  const t = normalizeForScan(text);
  const env = opts?.env ?? process.env;
  const hits: InternalHit[] = [];
  if (toolResults) {
    const hex = scanHex64Shape(t);
    if (hex) hits.push(hex);
    const bearer = scanRegex(t, BEARER, "bearer_token");
    if (bearer) hits.push(bearer);
  }
  const key = scanKeyMaterial(t, keyEncodingDigests(keyByteArrays(env)));
  if (key) hits.push(key);
  const bip39 = scanBip39(t);
  if (bip39) hits.push(bip39);
  for (const [rx, rule] of [
    [API_TOKEN, "api_token"],
    [CREDENTIALED_URL, "credentialed_url"],
    [ADMIN_HEADER, "admin_header"],
    [ENV_ASSIGNMENT, "env_assignment"],
  ] as Array<[RegExp, SecretScrubRule]>) {
    const hit = scanRegex(t, rx, rule);
    if (hit) hits.push(hit);
  }
  hits.push(...scanEnvSecrets(t, configuredSecrets(env)));
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
 * material are matched; defaults to `process.env`.
 */
export function scanForSecrets(text: string, opts?: { env?: NodeJS.ProcessEnv }): ScanResult {
  return toScanResult(scanInternal(text, opts, false));
}

/**
 * Replaces every detected secret-shaped span with "[redacted]" and returns
 * the rule ids that fired, on the NORMALIZED text (NFKC, zero-width stripped).
 * Used on untrusted tool results before they reach the model; adds the cheap
 * shape rules (hex64, bearer_token) that are deliberately absent from the
 * outbound gate.
 */
export function redactSecrets(text: string, opts?: { env?: NodeJS.ProcessEnv }): {
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
export function assertNoSecrets(text: string, opts?: { env?: NodeJS.ProcessEnv }): void {
  const scan = scanForSecrets(text, opts);
  if (!scan.clean) {
    throw new Error(`secret-scrubber refused outbound text: ${scan.hits.map((h) => h.rule).join(", ")}`);
  }
}
