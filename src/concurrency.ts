export class Semaphore {
  private n = 0;
  private waiters: Array<() => void> = [];

  constructor(readonly max: number) {
    if (max < 1) throw new Error("semaphore max must be >= 1");
  }

  get inFlight(): number {
    return this.n;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.n >= this.max) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.n += 1;
    try {
      return await fn();
    } finally {
      this.n -= 1;
      const next = this.waiters.shift();
      if (next) next();
    }
  }
}
