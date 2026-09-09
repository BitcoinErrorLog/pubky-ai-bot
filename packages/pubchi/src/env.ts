import { isIP } from "node:net";
import { PHASE0_BUDGETS } from "../pubchi-schemas/index.js";
import { log } from "../bot-kit/log.js";

const LOOPBACK_IPS = new Set(["127.0.0.1", "::1"]);

export const PUBCHI_DEFAULT_PORT = 3015;
export const PUBCHI_REQUEST_TIMEOUT_MS = 30_000;
export const PUBCHI_HEADERS_TIMEOUT_MS = 10_000;
export const PUBCHI_MAX_CONNECTIONS = 128;
export const PUBCHI_BODY_MAX_BYTES = 65_536;
export const PUBCHI_TENANT_CACHE_MS = 15_000;
export const PUBCHI_V1_SUNSET_DEFAULT_DAYS = 30;
const PUBCHI_DEFAULT_V1_SUNSET = Math.floor(Date.now() / 1000) + PUBCHI_V1_SUNSET_DEFAULT_DAYS * 24 * 60 * 60;

export function normalizePubchiOrigin(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error("PUBCHI_PUBLIC_ORIGIN must be an origin");
  }
  const loopback = parsed.hostname === "localhost" || LOOPBACK_IPS.has(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new Error("PUBCHI_PUBLIC_ORIGIN must use HTTPS");
  }
  if (parsed.username || parsed.password || parsed.pathname !== "/" && parsed.pathname !== "" || parsed.search || parsed.hash) {
    throw new Error("PUBCHI_PUBLIC_ORIGIN must be an origin");
  }
  parsed.protocol = parsed.protocol.toLowerCase();
  parsed.hostname = parsed.hostname.toLowerCase();
  if ((parsed.protocol === "https:" && parsed.port === "443") || (parsed.protocol === "http:" && parsed.port === "80")) {
    parsed.port = "";
  }
  return parsed.origin;
}

export function parsePubchiPublicOrigin(raw = process.env.PUBCHI_PUBLIC_ORIGIN): string | undefined {
  if (!raw || !raw.trim()) return undefined;
  return normalizePubchiOrigin(raw);
}

export function assertPubchiPublicOriginAllowed(raw = process.env.PUBCHI_PUBLIC_ORIGIN): string | undefined {
  const origin = parsePubchiPublicOrigin(raw);
  if (!origin) return undefined;
  const allowed = assertExactAllowedOrigins(process.env.PUBCHI_ALLOWED_ORIGINS);
  if (!allowed.map(normalizePubchiOrigin).includes(origin)) {
    throw new Error("PUBCHI_PUBLIC_ORIGIN must be listed in PUBCHI_ALLOWED_ORIGINS");
  }
  return origin;
}

export function parsePubchiV1Sunset(raw = process.env.PUBCHI_V1_SUNSET, now = Date.now()): number {
  if (raw && raw.trim()) {
    const value = Date.parse(raw.trim());
    if (!Number.isFinite(value)) throw new Error("invalid PUBCHI_V1_SUNSET");
    return Math.floor(value / 1000);
  }
  return PUBCHI_DEFAULT_V1_SUNSET;
}

export function parsePubchiPort(raw?: string): number {
  const inherited = raw === undefined || raw.trim() === "" ? process.env.PORT : raw;
  const s = inherited === undefined || inherited.trim() === "" ? String(PUBCHI_DEFAULT_PORT) : inherited.trim();
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

/** Per-owner budget/NLQ/Scout key. `bot` is ignored — Phase 0 enrollment is self-asserted. */
export function ownerBudgetKey(owner: string): string {
  return `pubchi:${owner}`;
}

export function scoutMentionKey(_bot: string, owner: string): string {
  return ownerBudgetKey(owner);
}

export function parsePreauthRps(raw?: string): number {
  const s = raw === undefined || raw.trim() === "" ? "20" : raw.trim();
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) throw new Error("invalid PUBCHI_PREAUTH_RPS");
  return n;
}

export function parsePreauthBurst(raw?: string): number {
  return positiveInt("PUBCHI_PREAUTH_BURST", raw, 40);
}

export function parsePreauthIpRps(raw?: string): number {
  const s = raw === undefined || raw.trim() === "" ? "5" : raw.trim();
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) throw new Error("invalid PUBCHI_PREAUTH_IP_RPS");
  return n;
}

export function parsePreauthIpBurst(raw?: string): number {
  return positiveInt("PUBCHI_PREAUTH_IP_BURST", raw, 10);
}

export function parseTrustProxy(raw?: string): boolean {
  const s = raw === undefined ? (process.env.PUBCHI_TRUST_PROXY ?? "") : raw;
  return s.trim() === "1";
}

/**
 * Device-delegation cutover switch. Default OFF: legacy root-signed requests
 * (no `signer`) stay accepted during the beta. When "1", any request lacking
 * a `signer` is rejected with UNAUTHORIZED.
 */
export function parseRequireDeviceSigner(raw?: string): boolean {
  const s = raw === undefined ? (process.env.PUBCHI_REQUIRE_DEVICE_SIGNER ?? "") : raw;
  return s.trim() === "1";
}

/** First X-Forwarded-For hop only when the operator set PUBCHI_TRUST_PROXY=1. */
export function clientAddress(opts: {
  remoteAddress?: string;
  forwardedFor?: string | string[] | undefined;
  trustProxy: boolean;
}): string {
  if (opts.trustProxy && opts.forwardedFor) {
    const raw = Array.isArray(opts.forwardedFor) ? opts.forwardedFor[0] : opts.forwardedFor;
    const first = raw.split(",")[0]?.trim();
    if (first) return first;
  }
  return opts.remoteAddress ?? "unknown";
}

/**
 * Exact Origin allowlist for browser callers. Empty / unset → no CORS headers
 * (today's server-to-server behaviour). Never `"*"`. Values are comma-separated
 * exact origins, e.g. `http://localhost:3001`.
 */
export function parseAllowedOrigins(raw?: string): string[] {
  const s = raw === undefined ? (process.env.PUBCHI_ALLOWED_ORIGINS ?? "") : raw;
  if (!s.trim()) return [];
  return [...new Set(s.split(",").map((p) => p.trim()).filter(Boolean))];
}

export function assertExactAllowedOrigins(raw: string | undefined): string[] {
  const origins = parseAllowedOrigins(raw);
  for (const origin of origins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error("PUBCHI_ALLOWED_ORIGINS must contain exact origins");
    }
    if (
      !/^https?:$/.test(parsed.protocol) ||
      parsed.origin !== origin ||
      (parsed.pathname !== "/" && parsed.pathname !== "")
    ) {
      throw new Error("PUBCHI_ALLOWED_ORIGINS must contain exact origins");
    }
  }
  return origins;
}

export function corsAllowHeaders(): string {
  return "content-type, accept";
}

/** Headers to send when `origin` is on the allowlist. Null = send none. */
export function corsHeadersForOrigin(origin: string | undefined, allowed: string[]): Record<string, string> | null {
  if (!origin || allowed.length === 0) return null;
  if (!allowed.includes(origin)) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
  };
}
