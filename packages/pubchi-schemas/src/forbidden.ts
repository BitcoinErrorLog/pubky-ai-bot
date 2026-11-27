import { validateMnemonic, wordlists } from "bip39";
import { err, ok, type ErrorCode, type ParseResult } from "./codes.js";

const CATEGORIES: Array<{ code: ErrorCode; keys: readonly string[] }> = [
  {
    code: "FORBIDDEN_SECRET",
    keys: [
      "mnemonic",
      "recovery_phrase",
      "recovery_file",
      "secret_key",
      "private_key",
      "root_key",
      "bot_key",
      "session",
      "session_cookie",
      "session_secret",
      "auth_token",
      "authtoken",
      "signup_token",
      "api_key",
      "password",
      "oauth_token",
      "credential",
      "credentials",
      "secret",
      "bearer",
      "key_material",
    ],
  },
  {
    code: "FORBIDDEN_PRIVATE",
    keys: [
      "direct_message",
      "direct_messages",
      "dm",
      "unlisted_post",
      "private_post",
      "private_file",
      "private_files",
      "clipboard",
      "clipboard_content",
    ],
  },
  {
    code: "FORBIDDEN_FINANCIAL",
    keys: [
      "payment_receipt",
      "invoice",
      "preimage",
      "wallet_address",
      "balance",
      "balances",
      "financial_note",
      "financial_notes",
    ],
  },
  {
    code: "FORBIDDEN_SENSITIVE",
    keys: ["health", "legal", "employment", "exact_location", "intimate", "medical", "intimate_note"],
  },
  {
    code: "FORBIDDEN_SURVEILLANCE",
    keys: [
      "browsing_history",
      "keystrokes",
      "raw_analytics",
      "device_id",
      "device_identifier",
      "ip_address",
      "contact_book",
      "contacts",
    ],
  },
  {
    code: "FORBIDDEN_INTERNAL",
    keys: [
      "system_prompt",
      "deployment_topology",
      "database_url",
      "internal_log",
      "internal_logs",
      "raw_provider_prompt",
      "provider_prompt",
    ],
  },
  {
    code: "FORBIDDEN_ARBITRARY",
    keys: ["remember", "remember_this", "extra", "custom_fields", "freeform"],
  },
];

const KEY_TO_CODE = new Map<string, ErrorCode>();
for (const cat of CATEGORIES) {
  for (const key of cat.keys) KEY_TO_CODE.set(key, cat.code);
}

/** Max object/array nesting for scanForbidden and canonicalize. */
export const MAX_JSON_DEPTH = 64;

function normalizeKey(key: string): string {
  return key.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`).replace(/_+/g, "_").toLowerCase();
}

export function scanForbidden(value: unknown): ParseResult<void> {
  const code = walk(value, 0);
  return code ? err(code) : ok(undefined);
}

const BIP39_WORDLISTS = Object.values(wordlists).filter((list): list is string[] => Array.isArray(list) && list.length === 2048);
const BIP39_WORD_SETS = BIP39_WORDLISTS.map((list) => new Set(list));
const BIP39_LENGTHS = [12, 15, 18, 21, 24] as const;

const SECRET_VALUE_PATTERNS = [
  /^(?:bearer|authtoken|signup[_-]?token)\s+\S+$/i,
  /^(?:sk|pk|api)[_-][A-Za-z0-9_-]{16,}$/,
] as const;

function normalizeSecretScan(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, "")
    .trim();
}

function isBip39WordSequence(raw: string): boolean {
  const normalized = normalizeSecretScan(raw).toLowerCase();
  const tokens = normalized.split(/[\s,;:|/]+/).filter(Boolean);
  if (tokens.length < 12) return false;
  if ((BIP39_LENGTHS as readonly number[]).includes(tokens.length)) {
    if (BIP39_WORD_SETS.some((set) => tokens.every((w) => set.has(w)))) {
      return true;
    }
  }
  for (let i = 0; i < BIP39_WORDLISTS.length; i += 1) {
    const list = BIP39_WORDLISTS[i];
    const set = BIP39_WORD_SETS[i];
    for (const len of BIP39_LENGTHS) {
      if (tokens.length < len) continue;
      for (let start = 0; start <= tokens.length - len; start += 1) {
        let allInList = true;
        for (let k = 0; k < len; k += 1) {
          if (!set.has(tokens[start + k])) {
            allInList = false;
            break;
          }
        }
        if (allInList && validateMnemonic(tokens.slice(start, start + len).join(" "), list)) {
          return true;
        }
      }
    }
  }
  return false;
}

export function scanForbiddenPublicState(value: unknown): ParseResult<void> {
  const forbidden = scanForbidden(value);
  if (!forbidden.ok) return forbidden;
  return hasSecretLookingValue(value, 0) ? err("FORBIDDEN_SECRET") : ok(undefined);
}

function hasSecretLookingValue(value: unknown, depth: number): boolean {
  if (depth > MAX_JSON_DEPTH) return true;
  if (typeof value === "string") {
    const trimmed = normalizeSecretScan(value);
    return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(trimmed)) || isBip39WordSequence(trimmed);
  }
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => hasSecretLookingValue(item, depth + 1));
  return Object.values(value as Record<string, unknown>).some((child) => hasSecretLookingValue(child, depth + 1));
}

function walk(value: unknown, depth: number): ErrorCode | undefined {
  if (depth > MAX_JSON_DEPTH) return "SCHEMA_INVALID";
  if (value === null || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = walk(item, depth + 1);
      if (hit) return hit;
    }
    return undefined;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const mapped = KEY_TO_CODE.get(normalizeKey(key));
    if (mapped) return mapped;
    const nested = walk(child, depth + 1);
    if (nested) return nested;
  }
  return undefined;
}

export const FORBIDDEN_CATEGORIES = CATEGORIES.map((c) => c.code);
