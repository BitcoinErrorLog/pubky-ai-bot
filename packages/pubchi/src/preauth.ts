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

export type KeyedLimiter = {
  take(key: string): boolean;
};

const KEYED_LIMITER_MAX_KEYS = 10_000;

/**
 * Token bucket per arbitrary key. Used to bound outbound homeserver fetches
 * against any single victim identity no matter how many sources ask. The key
 * space is capped so attacker-chosen keys cannot pin memory.
 */
export function memoryKeyedLimiter(opts: { rps: number; burst: number; now?: () => number }): KeyedLimiter {
  const now = opts.now ?? Date.now;
  const buckets = new Map<string, Bucket>();
  return {
    take(key) {
      const t = now();
      let bucket = buckets.get(key);
      if (!bucket) {
        if (buckets.size >= KEYED_LIMITER_MAX_KEYS) {
          const oldest = buckets.keys().next().value;
          if (oldest !== undefined) buckets.delete(oldest);
        }
        bucket = { tokens: opts.burst, updated: t };
        buckets.set(key, bucket);
      } else {
        refill(bucket, t, opts.rps, opts.burst);
      }
      if (bucket.tokens < 1) return false;
      bucket.tokens -= 1;
      return true;
    },
  };
}
