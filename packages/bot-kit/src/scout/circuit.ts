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

function breakerLimits() {
  return {
    n: envPositiveInt("JEB_SCOUT_BREAKER_FAILURES", DEFAULT_BREAKER_FAILURES),
    windowMs: envPositiveInt("JEB_SCOUT_BREAKER_WINDOW_MS", DEFAULT_BREAKER_WINDOW_MS),
    cooldownMs: envPositiveInt("JEB_SCOUT_BREAKER_COOLDOWN_MS", DEFAULT_BREAKER_COOLDOWN_MS),
  };
}

/** Error-rate circuit breaker. State is per instance so tests cannot share it. */
export class ScoutCircuitBreaker {
  private failures: number[] = [];
  private openUntil = 0;
  private open = false;

  constructor(private readonly now: () => number = Date.now) {}

  reset(): void {
    this.failures = [];
    this.openUntil = 0;
    this.open = false;
  }

  /** True when the breaker is open (do not call Scout). */
  blocked(): boolean {
    const t = this.now();
    if (this.openUntil > 0 && t >= this.openUntil) {
      this.openUntil = 0;
      this.failures = [];
      if (this.open) {
        this.open = false;
        log.info({ event: "scout_breaker_closed" }, "scout circuit breaker closed");
      }
    }
    return this.openUntil > t;
  }

  noteOutcome(ok: boolean): void {
    const t = this.now();
    if (ok) {
      this.failures = [];
      if (this.open && t >= this.openUntil) {
        this.open = false;
        this.openUntil = 0;
        log.info({ event: "scout_breaker_closed" }, "scout circuit breaker closed");
      }
      return;
    }
    const { n, windowMs, cooldownMs } = breakerLimits();
    this.failures.push(t);
    this.failures = this.failures.filter((ts) => t - ts <= windowMs);
    if (this.failures.length >= n && !this.open) {
      this.open = true;
      this.openUntil = t + cooldownMs;
      log.warn(
        { event: "scout_breaker_open", failures: this.failures.length, cooldown_ms: cooldownMs },
        "scout circuit breaker open",
      );
    }
  }
}

const defaultBreaker = new ScoutCircuitBreaker();

export function resetScoutBreakerForTests(): void {
  defaultBreaker.reset();
}

/** True when the error-rate circuit breaker is open (do not call Scout). */
export function scoutBreakerBlocked(): boolean {
  return defaultBreaker.blocked();
}

export function noteScoutOutcome(ok: boolean): void {
  defaultBreaker.noteOutcome(ok);
}
