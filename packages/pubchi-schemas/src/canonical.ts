import { createHash } from "node:crypto";
import { MAX_JSON_DEPTH } from "./forbidden.js";

/** Deterministic JSON: sorted keys, no whitespace, no undefined. */
export function canonicalize(value: unknown, depth = 0): unknown {
  if (depth > MAX_JSON_DEPTH) throw new RangeError("too deep");
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => canonicalize(item, depth + 1));
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const next = obj[key];
    if (next === undefined) continue;
    out[key] = canonicalize(next, depth + 1);
  }
  return out;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function bodySha256(body: unknown): string {
  return sha256Hex(canonicalJson(body === undefined ? null : body));
}

export const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
