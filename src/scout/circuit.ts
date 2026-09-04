import { log } from "../log.js";

const DEFAULT_BREAKER_FAILURES = 5;
const DEFAULT_BREAKER_WINDOW_MS = 60_000;
const DEFAULT_BREAKER_COOLDOWN_MS = 60_000;

function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.floor(n);
}

interface BreakerState {
  failures: number[];
  openUntil: number;
  open: boolean;
}

const breaker: BreakerState = { failures: [], openUntil: 0, open: false };

export function resetScoutBreakerForTests(): void {
  breaker.failures = [];
  breaker.openUntil = 0;
  breaker.open = false;
}

function breakerLimits() {
  return {
    n: envPositiveInt("JEB_SCOUT_BREAKER_FAILURES", DEFAULT_BREAKER_FAILURES),
    windowMs: envPositiveInt("JEB_SCOUT_BREAKER_WINDOW_MS", DEFAULT_BREAKER_WINDOW_MS),
    cooldownMs: envPositiveInt("JEB_SCOUT_BREAKER_COOLDOWN_MS", DEFAULT_BREAKER_COOLDOWN_MS),
  };
}

/** True when the error-rate circuit breaker is open (do not call Scout). */
export function scoutBreakerBlocked(): boolean {
  if (breaker.openUntil > 0 && Date.now() >= breaker.openUntil) {
    breaker.openUntil = 0;
    breaker.failures = [];
    if (breaker.open) {
      breaker.open = false;
      log.info({ event: "scout_breaker_closed" }, "scout circuit breaker closed");
    }
  }
  return breaker.openUntil > Date.now();
}

export function noteScoutOutcome(ok: boolean): void {
  if (ok) {
    breaker.failures = [];
    if (breaker.open && Date.now() >= breaker.openUntil) {
      breaker.open = false;
      breaker.openUntil = 0;
      log.info({ event: "scout_breaker_closed" }, "scout circuit breaker closed");
    }
    return;
  }
  const now = Date.now();
  const { n, windowMs, cooldownMs } = breakerLimits();
  breaker.failures.push(now);
  breaker.failures = breaker.failures.filter((t) => now - t <= windowMs);
  if (breaker.failures.length >= n && !breaker.open) {
    breaker.open = true;
    breaker.openUntil = now + cooldownMs;
    log.warn(
      { event: "scout_breaker_open", failures: breaker.failures.length, cooldown_ms: cooldownMs },
      "scout circuit breaker open",
    );
  }
}
