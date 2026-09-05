import { isIP } from "node:net";
import { PHASE0_BUDGETS } from "../pubchi-schemas/index.js";
import { log } from "../bot-kit/log.js";

const LOOPBACK_IPS = new Set(["127.0.0.1", "::1"]);

export const PUBCHI_DEFAULT_PORT = 3015;
export const PUBCHI_REQUEST_TIMEOUT_MS = 30_000;
export const PUBCHI_HEADERS_TIMEOUT_MS = 10_000;
export const PUBCHI_MAX_CONNECTIONS = 128;
export const PUBCHI_BODY_MAX_BYTES = 65_536;
export const PUBCHI_TENANT_CACHE_MS = 60_000;

export function parsePubchiPort(raw?: string): number {
  const s = raw === undefined || raw.trim() === "" ? String(PUBCHI_DEFAULT_PORT) : raw.trim();
  if (!/^\d+$/.test(s)) throw new Error("invalid PUBCHI_PORT");
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error("invalid PUBCHI_PORT");
  return n;
}

export function pubchiBind(bind?: string): string {
  const raw = bind?.trim();
  if (!raw) return "127.0.0.1";
  if (!isIP(raw)) throw new Error("invalid PUBCHI_BIND");
  return raw;
}

export function isLoopbackBind(bind: string): boolean {
  return LOOPBACK_IPS.has(bind);
}

export function assertPubchiBindAllowed(bind: string): void {
  if (isLoopbackBind(bind)) return;
  if (process.env.PUBCHI_BIND_DANGEROUS === "1") {
    log.warn(
      { event: "pubchi_bind_dangerous", bind },
      "Pubchi listening on non-loopback bind; PUBCHI_BIND_DANGEROUS=1 is set",
    );
    return;
  }
  throw new Error("PUBCHI_BIND is not loopback; set PUBCHI_BIND_DANGEROUS=1 to allow");
}

export function pubchiHttpBase(bind: string, port?: number): string {
  const host = bind.includes(":") ? `[${bind}]` : bind;
  return port === undefined ? `http://${host}` : `http://${host}:${port}`;
}

function positiveInt(name: string, raw: string | undefined, fallback: number): number {
  const s = raw === undefined || raw.trim() === "" ? String(fallback) : raw.trim();
  if (!/^\d+$/.test(s)) throw new Error(`invalid ${name}`);
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1) throw new Error(`invalid ${name}`);
  return n;
}

export function parseDailyTokenCeiling(raw?: string): number {
  return positiveInt("PUBCHI_DAILY_TOKEN_CEILING", raw, PHASE0_BUDGETS.per_owner_utc_day_tokens);
}

export function parsePerRequestTokenCap(raw?: string): number {
  const fallback = PHASE0_BUDGETS.per_request_input_tokens + PHASE0_BUDGETS.per_request_output_tokens;
  return positiveInt("PUBCHI_PER_REQUEST_TOKEN_CAP", raw, fallback);
}

export function parseBodyMaxBytes(raw?: string): number {
  return positiveInt("PUBCHI_BODY_MAX_BYTES", raw, PUBCHI_BODY_MAX_BYTES);
}

export function parseRequestTimeoutMs(raw?: string): number {
  return positiveInt("PUBCHI_REQUEST_TIMEOUT_MS", raw, PUBCHI_REQUEST_TIMEOUT_MS);
}

export function parseBucketRatePerSec(raw?: string): number {
  const s = raw === undefined || raw.trim() === "" ? "2" : raw.trim();
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) throw new Error("invalid PUBCHI_BUCKET_RATE_PER_SEC");
  return n;
}

export function parseBucketBurst(raw?: string): number {
  return positiveInt("PUBCHI_BUCKET_BURST", raw, 10);
}

export function scoutMentionKey(bot: string, owner: string): string {
  return `pubchi:${bot}:${owner}`;
}
