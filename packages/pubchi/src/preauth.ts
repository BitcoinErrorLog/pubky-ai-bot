export type PreauthLimiter = {
  take(remoteAddress: string): boolean;
};

type Bucket = { tokens: number; updated: number };

function refill(s: Bucket, now: number, ratePerSec: number, burst: number): void {
  const elapsed = (now - s.updated) / 1000;
  s.tokens = Math.min(burst, s.tokens + elapsed * ratePerSec);
  s.updated = now;
}

/**
 * Cheap pre-auth limiter: one global bucket plus one per remote address.
 * Used before parse/verify so unsigned POSTs cannot exhaust connections.
 */
export function memoryPreauthLimiter(opts: {
  globalRps: number;
  globalBurst: number;
  ipRps: number;
  ipBurst: number;
}): PreauthLimiter {
  const global: Bucket = { tokens: opts.globalBurst, updated: Date.now() };
  const ips = new Map<string, Bucket>();
  return {
    take(remoteAddress: string) {
      const now = Date.now();
      refill(global, now, opts.globalRps, opts.globalBurst);
      let ip = ips.get(remoteAddress);
      if (!ip) {
        ip = { tokens: opts.ipBurst, updated: now };
        ips.set(remoteAddress, ip);
      } else {
        refill(ip, now, opts.ipRps, opts.ipBurst);
      }
      if (global.tokens < 1 || ip.tokens < 1) return false;
      global.tokens -= 1;
      ip.tokens -= 1;
      return true;
    },
  };
}
