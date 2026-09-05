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

function normalizeKey(key: string): string {
  return key.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`).replace(/_+/g, "_").toLowerCase();
}

export function scanForbidden(value: unknown): ParseResult<void> {
  const code = walk(value);
  return code ? err(code) : ok(undefined);
}

function walk(value: unknown): ErrorCode | undefined {
  if (value === null || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = walk(item);
      if (hit) return hit;
    }
    return undefined;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const mapped = KEY_TO_CODE.get(normalizeKey(key));
    if (mapped) return mapped;
    const nested = walk(child);
    if (nested) return nested;
  }
  return undefined;
}

export const FORBIDDEN_CATEGORIES = CATEGORIES.map((c) => c.code);
