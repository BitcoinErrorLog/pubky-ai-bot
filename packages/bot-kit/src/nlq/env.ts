import { isIP } from "node:net";
import { log } from "../log.js";

const LOOPBACK_IPS = new Set(["127.0.0.1", "::1"]);

export function parseNlqPort(raw?: string): number {
  const s = raw === undefined || raw.trim() === "" ? "3014" : raw.trim();
  if (!/^\d+$/.test(s)) throw new Error("invalid JEB_NLQ_PORT");
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error("invalid JEB_NLQ_PORT");
  return n;
}

export function nlqBind(bind?: string): string {
  const raw = bind?.trim();
  if (!raw) return "127.0.0.1";
  if (!isIP(raw)) throw new Error("invalid JEB_NLQ_BIND");
  return raw;
}

export function isLoopbackBind(bind: string): boolean {
  return LOOPBACK_IPS.has(bind);
}

export function assertNlqBindAllowed(bind: string): void {
  if (isLoopbackBind(bind)) return;
  if (process.env.JEB_NLQ_BIND_DANGEROUS === "1") {
    log.warn(
      { event: "nlq_bind_dangerous", bind },
      "NLQ listening on non-loopback bind; JEB_NLQ_BIND_DANGEROUS=1 is set",
    );
    return;
  }
  throw new Error("JEB_NLQ_BIND is not loopback; set JEB_NLQ_BIND_DANGEROUS=1 to allow");
}

export function nlqHttpBase(bind: string, port?: number): string {
  const host = bind.includes(":") ? `[${bind}]` : bind;
  return port === undefined ? `http://${host}` : `http://${host}:${port}`;
}

export function parseNlqDailyQueries(raw?: string): number {
  const s = raw === undefined || raw.trim() === "" ? "200" : raw.trim();
  if (!/^\d+$/.test(s)) throw new Error("invalid JEB_NLQ_DAILY_QUERIES");
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1) throw new Error("invalid JEB_NLQ_DAILY_QUERIES");
  return n;
}
