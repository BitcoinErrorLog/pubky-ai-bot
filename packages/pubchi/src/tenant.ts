import {
  ownerBindingUri,
  delegationUri,
  parseDeviceDelegationV1,
  verifyDeviceDelegationV1,
  parseOwnerBindingV1,
  parseTenantV1,
  PHASE0_BRAIN,
  PHASE0_BUDGETS,
  PHASE0_TIER,
  type TenantV1,
  type DeviceDelegationV1,
  type Phase0Purpose,
} from "../pubchi-schemas/index.js";
import { PUBCHI_TENANT_CACHE_MS } from "./env.js";
import { memoryKeyedLimiter, type KeyedLimiter } from "./preauth.js";
import type { PublicHomeserverReader } from "./homeserver-read.js";
import type { ServiceErrorCode } from "./codes.js";

export const TENANT_NEGATIVE_CACHE_MS = 30_000;

export type TenantFail = {
  ok: false;
  code: ServiceErrorCode;
  cause?: string;
  upstream_host?: string;
  upstream_status?: number;
};

export type TenantResolve = { ok: true; tenant: TenantV1 } | TenantFail;

type CacheEntry = { at: number; result: TenantResolve };

export type TenantResolver = {
  resolve(asker: string, bot: string): Promise<TenantResolve>;
  resolveDelegation(
    owner: string,
    signer: string,
    bot: string,
    purpose: Phase0Purpose,
    now: number,
  ): Promise<DelegationResolve>;
  clear(): void;
};

export type DelegationResolve =
  | { ok: true; delegation: DeviceDelegationV1 }
  | TenantFail;

/**
 * Positive delegation cache: 15s, so a revoked or replaced device delegation
 * stops being honored within 15s (owner/bot/purpose/expiry are re-verified on
 * every cache hit). Authoritative negatives (404 / unparsable doc) stay cached
 * for 60s so repeats are free; upstream blips for 30s.
 */
export const DELEGATION_CACHE_MS = 15_000;
export const DELEGATION_NEGATIVE_CACHE_MS = 30_000;
export const DELEGATION_MISS_CACHE_MS = 60_000;
/** Hard caps so attacker-chosen cache keys cannot pin memory. */
export const TENANT_CACHE_MAX_ENTRIES = 4096;
export const DELEGATION_CACHE_MAX_ENTRIES = 1024;
/**
 * Per-victim outbound fetch budget: at most 4 immediate homeserver fetches
 * against one asker/owner identity, refilling at 2 per 60s, no matter how
 * many sources ask. Cache hits never consume the budget.
 */
export const ASKER_FETCH_BURST = 4;
export const ASKER_FETCH_RPS = 2 / 60;

function tenantFromBinding(owner: string, bot: string, createdAt: number, updatedAt: number): TenantV1 {
  return {
    schema: "pubchi-tenant",
    version: 1,
    bot,
    owner,
    tier: PHASE0_TIER,
    brain: { ...PHASE0_BRAIN },
    budgets: { ...PHASE0_BUDGETS },
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

function parseEnrollment(body: unknown, asker: string, bot: string): TenantResolve {
  if (body && typeof body === "object" && "tier" in body) {
    const tier = (body as { tier: unknown }).tier;
    if (tier !== PHASE0_TIER) return { ok: false, code: "TIER_UNSUPPORTED" };
  }

  const tenant = parseTenantV1(body);
  if (tenant.ok) {
    if (tenant.value.bot !== bot) return { ok: false, code: "BOT_MISMATCH" };
    if (tenant.value.owner !== asker) return { ok: false, code: "ASKER_MISMATCH" };
    if (tenant.value.tier !== PHASE0_TIER) return { ok: false, code: "TIER_UNSUPPORTED" };
    return { ok: true, tenant: tenant.value };
  }

  const binding = parseOwnerBindingV1(body);
  if (binding.ok) {
    if (binding.value.status !== "active") return { ok: false, code: "TENANT_NOT_ENROLLED" };
    if (binding.value.bot !== bot) return { ok: false, code: "BOT_MISMATCH" };
    if (binding.value.owner !== asker) return { ok: false, code: "ASKER_MISMATCH" };
    return {
      ok: true,
      tenant: tenantFromBinding(binding.value.owner, binding.value.bot, binding.value.created_at, binding.value.updated_at),
    };
  }
  return { ok: false, code: tenant.code === "UNKNOWN_FIELD" ? "UNKNOWN_FIELD" : "SCHEMA_INVALID" };
}

function bindingHost(uri: string): string {
  return uri.replace(/^pubky:\/\//, "").split("/")[0] ?? "homeserver";
}

export function createTenantResolver(
  reader: PublicHomeserverReader,
  opts?: { cacheMs?: number; now?: () => number; fetchLimiter?: KeyedLimiter },
): TenantResolver {
  const successCacheMs = opts?.cacheMs ?? PUBCHI_TENANT_CACHE_MS;
  const now = opts?.now ?? Date.now;
  const fetchLimiter =
    opts?.fetchLimiter ?? memoryKeyedLimiter({ rps: ASKER_FETCH_RPS, burst: ASKER_FETCH_BURST, now });
  const cache = new Map<string, CacheEntry>();
  const delegationCache = new Map<string, { at: number; result: DelegationResolve }>();

  function ttlFor(result: TenantResolve): number {
    if (!result.ok && result.code === "UPSTREAM_UNAVAILABLE") return TENANT_NEGATIVE_CACHE_MS;
    return successCacheMs;
  }

  function delegationTtlFor(result: DelegationResolve): number {
    if (result.ok) return DELEGATION_CACHE_MS;
    if (result.code === "UPSTREAM_UNAVAILABLE") return DELEGATION_NEGATIVE_CACHE_MS;
    return DELEGATION_MISS_CACHE_MS;
  }

  /** Insert with expired-entry sweep, then evict oldest beyond the hard cap. */
  function cappedSet<V extends { at: number }, R>(
    map: Map<string, V & { result: R }>,
    maxEntries: number,
    ttlOf: (result: R) => number,
    key: string,
    value: V & { result: R },
  ): void {
    const t = now();
    for (const [k, v] of map) {
      if (t - v.at >= ttlOf(v.result)) map.delete(k);
    }
    map.delete(key);
    map.set(key, value);
    while (map.size > maxEntries) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  function fetchLimited(): TenantFail {
    return { ok: false, code: "UPSTREAM_UNAVAILABLE", cause: "asker_fetch_limited" };
  }

  return {
    async resolve(asker: string, bot: string): Promise<TenantResolve> {
      const key = `${asker}:${bot}`;
      const hit = cache.get(key);
      const t = now();
      if (hit && t - hit.at < ttlFor(hit.result)) return hit.result;
      // Bound outbound fetches per victim asker; cache hits above are free.
      if (!fetchLimiter.take(asker)) return fetchLimited();
      const uri = ownerBindingUri(asker, bot);
      let fetched;
      try {
        fetched = await reader.getJson(uri);
      } catch {
        const result: TenantResolve = {
          ok: false,
          code: "UPSTREAM_UNAVAILABLE",
          cause: "homeserver_read_failed",
          upstream_host: bindingHost(uri),
          upstream_status: 0,
        };
        cappedSet(cache, TENANT_CACHE_MAX_ENTRIES, ttlFor, key, { at: t, result });
        return result;
      }
      if (fetched.status === 404) {
        const result: TenantResolve = { ok: false, code: "TENANT_NOT_ENROLLED" };
        cappedSet(cache, TENANT_CACHE_MAX_ENTRIES, ttlFor, key, { at: t, result });
        return result;
      }
      if (fetched.status !== 200) {
        const result: TenantResolve = {
          ok: false,
          code: "UPSTREAM_UNAVAILABLE",
          cause: `homeserver_http_${fetched.status}`,
          upstream_host: bindingHost(uri),
          upstream_status: fetched.status,
        };
        cappedSet(cache, TENANT_CACHE_MAX_ENTRIES, ttlFor, key, { at: t, result });
        return result;
      }
      const result = parseEnrollment(fetched.body, asker, bot);
      cappedSet(cache, TENANT_CACHE_MAX_ENTRIES, ttlFor, key, { at: t, result });
      return result;
    },
    async resolveDelegation(owner, signer, bot, purpose, delegationNow) {
      const key = `${owner}:${signer}`;
      const hit = delegationCache.get(key);
      const t = now();
      if (hit && t - hit.at < delegationTtlFor(hit.result)) {
        if (hit.result.ok) {
          const checked = verifyDeviceDelegationV1(hit.result.delegation, owner, signer, bot, purpose, delegationNow);
          return checked.ok ? { ok: true, delegation: checked.value } : checked;
        }
        return hit.result;
      }
      // Same per-victim budget as enrollment fetches; the victim is the owner.
      if (!fetchLimiter.take(owner)) return fetchLimited();
      const uri = delegationUri(owner, signer);
      let fetched;
      try {
        fetched = await reader.getJson(uri);
      } catch {
        const result: DelegationResolve = {
          ok: false,
          code: "UPSTREAM_UNAVAILABLE",
          cause: "homeserver_read_failed",
          upstream_host: bindingHost(uri),
          upstream_status: 0,
        };
        cappedSet(delegationCache, DELEGATION_CACHE_MAX_ENTRIES, delegationTtlFor, key, { at: t, result });
        return result;
      }
      if (fetched.status === 404) {
        const result: DelegationResolve = { ok: false, code: "DELEGATION_NOT_FOUND" };
        cappedSet(delegationCache, DELEGATION_CACHE_MAX_ENTRIES, delegationTtlFor, key, { at: t, result });
        return result;
      }
      if (fetched.status !== 200) {
        const result: DelegationResolve = {
          ok: false,
          code: "UPSTREAM_UNAVAILABLE",
          cause: `homeserver_http_${fetched.status}`,
          upstream_host: bindingHost(uri),
          upstream_status: fetched.status,
        };
        cappedSet(delegationCache, DELEGATION_CACHE_MAX_ENTRIES, delegationTtlFor, key, { at: t, result });
        return result;
      }
      const parsed = parseDeviceDelegationV1(fetched.body);
      const result: DelegationResolve = parsed.ok
        ? { ok: true, delegation: parsed.value }
        : { ok: false, code: parsed.code };
      cappedSet(delegationCache, DELEGATION_CACHE_MAX_ENTRIES, delegationTtlFor, key, { at: t, result });
      if (!result.ok) return result;
      const checked = verifyDeviceDelegationV1(result.delegation, owner, signer, bot, purpose, delegationNow);
      return checked.ok ? { ok: true, delegation: checked.value } : checked;
    },
    clear() {
      cache.clear();
      delegationCache.clear();
    },
  };
}

export { parseEnrollment };
