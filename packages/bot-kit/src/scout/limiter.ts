/** Client-side token bucket for outgoing Scout HTTP calls. */

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly qps: number,
    private readonly capacity: number,
    private readonly now: () => number = Date.now,
  ) {
    if (!(qps > 0) || !(capacity > 0)) throw new Error("token bucket qps and capacity must be positive");
    this.tokens = capacity;
    this.lastRefill = now();
  }

  private refill(): void {
    const t = this.now();
    const elapsed = Math.max(0, t - this.lastRefill);
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed / 1000) * this.qps);
    this.lastRefill = t;
  }

  tryTake(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /** Wait until a token is available, or until maxWaitMs elapses. */
  async acquire(maxWaitMs: number): Promise<boolean> {
    const deadline = this.now() + Math.max(0, maxWaitMs);
    while (true) {
      if (this.tryTake()) return true;
      const remaining = deadline - this.now();
      if (remaining <= 0) return false;
      const msForOne = ((1 - this.tokens) / this.qps) * 1000;
      const wait = Math.max(1, Math.min(msForOne, remaining, 50));
      await new Promise<void>((resolve) => setTimeout(resolve, wait));
    }
  }
}

export function scoutBucketCapacity(qps: number): number {
  return Math.max(1, Math.ceil(qps));
}
