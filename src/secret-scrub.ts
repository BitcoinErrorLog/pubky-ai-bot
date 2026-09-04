/**
 * Secret scrubber: the publisher-side last gate before any bytes leave under
 * the bot key, and the same rule set applied to untrusted tool results before
 * they re-enter the model context (src/tool-screen.ts).
 *
 * Rules detect secret-shaped material in outbound text: Ed25519-shaped hex,
 * BIP39 mnemonics, common API token shapes, bearer tokens, credentialed
 * database URLs, admin headers, and the literal values of configured secret
 * env vars. Detections are reported by rule id ONLY — the matched text is
 * never returned, logged, or stored.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { wordlists } from "bip39";

export const SECRET_SCRUB_RULES = [
  "hex64",
  "bip39",
  "api_token",
  "bearer_token",
  "credentialed_url",
  "admin_header",
  "env_secret",
  "signup_token",
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

/** Ed25519 secret shape: 64 hex chars, contiguous… */
const HEX64 = /\b[0-9a-fA-F]{64}\b/g;
/** …or split with spaces/newlines inside (obfuscation). */
const HEX_SPLIT = /[0-9a-fA-F]+(?:[ \t\r\n]+[0-9a-fA-F]+)+/g;

const API_TOKEN =
  /\b(?:sk-[A-Za-z0-9_-]{8,}|sk_live_[A-Za-z0-9]{8,}|sk_test_[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{8,}|gho_[A-Za-z0-9]{8,}|ghu_[A-Za-z0-9]{8,}|ghs_[A-Za-z0-9]{8,}|ghr_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{16})\b/g;

const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;

const CREDENTIALED_URL = /\b(?:postgres(?:ql)?|redis):\/\/[^\s/?#@]*:[^\s/?#@]+@/gi;

const ADMIN_HEADER = /X-Admin-Password/gi;

const BIP39_WORDS: ReadonlySet<string> = new Set(wordlists.english);
const BIP39_WINDOW_SIZES = [12, 15, 18, 21, 24] as const;
const BIP39_MIN_FRACTION = 0.9;

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

/** Shorter values are too likely to collide with ordinary prose. */
const ENV_SECRET_MIN_LEN = 8;

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

interface HashedSecret {
  rule: "env_secret" | "signup_token";
  hash: Buffer;
  raw: string;
}

/**
 * Configured secret values from the given env (default: this process's env),
 * kept only as sha256 digests for constant-time comparison. The raw value is
 * retained solely for redaction span replacement and never leaves the module.
 */
function hashedSecrets(env: NodeJS.ProcessEnv): HashedSecret[] {
  const out: HashedSecret[] = [];
  const seen = new Set<string>();
  const names = new Set<string>(SECRET_ENV_NAMES);
  for (const k of Object.keys(env)) {
    if (k.startsWith("PUBKY_BOT_")) names.add(k);
  }
  for (const name of names) {
    const raw = env[name]?.trim();
    if (!raw || raw.length < ENV_SECRET_MIN_LEN || seen.has(raw)) continue;
    seen.add(raw);
    out.push({ rule: name === "JEB_SIGNUP_TOKEN" ? "signup_token" : "env_secret", hash: sha256(raw), raw });
  }
  return out;
}

/** Candidate tokens: whitespace-separated, stripped of surrounding punctuation. */
function candidateTokens(text: string): Array<{ token: string; index: number; end: number }> {
  const out: Array<{ token: string; index: number; end: number }> = [];
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

function scanHex64(text: string): InternalHit | null {
  const spans: Span[] = [];
  HEX64.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HEX64.exec(text))) spans.push({ start: m.index, end: m.index + m[0].length });
  HEX_SPLIT.lastIndex = 0;
  while ((m = HEX_SPLIT.exec(text))) {
    const compact = m[0].replace(/[ \t\r\n]+/g, "");
    if (compact.length === 64) spans.push({ start: m.index, end: m.index + m[0].length });
  }
  return spans.length ? { rule: "hex64", spans } : null;
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

function scanBip39(text: string): InternalHit | null {
  const words: Array<{ word: string; index: number; end: number }> = [];
  const rx = /[A-Za-z]+/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(text))) {
    words.push({ word: m[0].toLowerCase(), index: m.index, end: m.index + m[0].length });
  }
  const spans: Span[] = [];
  for (const size of BIP39_WINDOW_SIZES) {
    if (words.length < size) continue;
    const minHits = Math.ceil(size * BIP39_MIN_FRACTION);
    let inList = 0;
    for (let i = 0; i < size; i++) if (BIP39_WORDS.has(words[i].word)) inList++;
    for (let i = 0; i + size <= words.length; i++) {
      if (i > 0) {
        if (BIP39_WORDS.has(words[i - 1].word)) inList--;
        if (BIP39_WORDS.has(words[i + size - 1].word)) inList++;
      }
      if (inList >= minHits) {
        spans.push({ start: words[i].index, end: words[i + size - 1].end });
      }
    }
  }
  return spans.length ? { rule: "bip39", spans } : null;
}

function scanEnvSecrets(text: string, secrets: HashedSecret[]): InternalHit[] {
  if (secrets.length === 0) return [];
  const byRule = new Map<"env_secret" | "signup_token", Span[]>();
  for (const cand of candidateTokens(text)) {
    const h = sha256(cand.token);
    for (const secret of secrets) {
      if (!hashEquals(h, secret.hash)) continue;
      const spans = byRule.get(secret.rule) ?? [];
      spans.push({ start: cand.index, end: cand.end });
      byRule.set(secret.rule, spans);
    }
  }
  return [...byRule.entries()].map(([rule, spans]) => ({ rule, spans }));
}

function scanInternal(text: string, opts?: { env?: NodeJS.ProcessEnv }): InternalHit[] {
  if (!text) return [];
  const hits: InternalHit[] = [];
  const hex = scanHex64(text);
  if (hex) hits.push(hex);
  const bip39 = scanBip39(text);
  if (bip39) hits.push(bip39);
  for (const [rx, rule] of [
    [API_TOKEN, "api_token"],
    [BEARER, "bearer_token"],
    [CREDENTIALED_URL, "credentialed_url"],
    [ADMIN_HEADER, "admin_header"],
  ] as Array<[RegExp, SecretScrubRule]>) {
    const hit = scanRegex(text, rx, rule);
    if (hit) hits.push(hit);
  }
  hits.push(...scanEnvSecrets(text, hashedSecrets(opts?.env ?? process.env)));
  return hits;
}

/**
 * Scans outbound text for secret-shaped material. Returns rule ids only.
 * `opts.env` overrides the env whose configured secret values are compared
 * (hashed, constant-time); defaults to `process.env`.
 */
export function scanForSecrets(text: string, opts?: { env?: NodeJS.ProcessEnv }): ScanResult {
  const internal = scanInternal(text, opts);
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
 * Replaces every detected secret-shaped span with "[redacted]" and returns
 * the rule ids that fired. Used on untrusted tool results before they reach
 * the model, so a poisoned post/page cannot smuggle a fake key into context.
 */
export function redactSecrets(text: string, opts?: { env?: NodeJS.ProcessEnv }): {
  text: string;
  hits: ScrubHit[];
} {
  const internal = scanInternal(text, opts);
  if (internal.length === 0) return { text, hits: [] };
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
    out += text.slice(cursor, s.start);
    out += REDACTED;
    cursor = s.end;
  }
  out += text.slice(cursor);
  return { text: out, hits };
}

/**
 * Throws when the text contains secret-shaped material. For operator tooling
 * (scripts/post.ts, scripts/profile.ts) where refusing beats publishing a
 * decline. The error names rule ids only, never the matched text.
 */
export function assertNoSecrets(text: string, opts?: { env?: NodeJS.ProcessEnv }): void {
  const scan = scanForSecrets(text, opts);
  if (!scan.clean) {
    throw new Error(`secret-scrubber refused outbound text: ${scan.hits.map((h) => h.rule).join(", ")}`);
  }
}
