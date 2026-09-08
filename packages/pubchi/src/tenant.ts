import {
  botUri,
  configUri,
  ownerBindingUri,
  delegationUri,
  parsePubchiBotV1,
  parsePubchiConfigV1,
  parseDeviceDelegationV1,
  verifyDeviceDelegationV1,
  parseOwnerBindingV1,
  PHASE0_BRAIN,
  TIER_BUDGETS,
  type TenantV1,
  type Tier,
  type DeviceDelegationV1,
  type Phase0Purpose,
} from "../pubchi-schemas/index.js";
import { log } from "../bot-kit/log.js";
import { PUBCHI_TENANT_CACHE_MS } from "./env.js";
import { memoryKeyedLimiter, type KeyedLimiter } from "./preauth.js";
import type { PublicHomeserverReader } from "./homeserver-read.js";
import type { ServiceErrorCode } from "./codes.js";

export const TENANT_NEGATIVE_CACHE_MS = 30_000;
export const TENANT_MISS_CACHE_MS = 60_000;
export const PUBCHI_V1_TIER_CEILING = "assisted" as const;

export type TenantFail = {
  ok: false;
  code: ServiceErrorCode;
  cause?: string;
  upstream_host?: string;
  upstream_status?: number;
};

export type TenantResolve = { ok: true; tenant: TenantV1 } | TenantFail;

type CacheEntry = { at: number; result: TenantResolve; requestedBot: string };

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

export type EffectiveTierInputs = {
  config_tier: Tier;
  credential_tier: Tier;
  switch_tier: Tier;
  budget_tier: Tier;
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

const TIER_RANK: Record<Tier, number> = {
  "read-only": 1,
  assisted: 2,
  autonomous: 3,
};

export function effectiveTier(inputs: EffectiveTierInputs): Tier {
  return Object.values(inputs).reduce<Tier>(
    (current, candidate) => TIER_RANK[current] <= TIER_RANK[candidate] ? current : candidate,
    "autonomous",
  );
}

function budgetTier(configTier: Tier): Tier {
  return TIER_BUDGETS[configTier].proactive_suggestions_per_day > 0 ? "autonomous" : "assisted";
}

function tenantFromBinding(
  owner: string,
  bot: string,
  tier: Tier,
  createdAt: number,
  updatedAt: number,
): TenantV1 {
  return {
    schema: "pubchi-tenant",
    version: 1,
    bot,
    owner,
    tier,
    brain: { ...PHASE0_BRAIN },
    budgets: { ...TIER_BUDGETS[tier] },
    created_at: createdAt,
    updated_at: updatedAt,
  } as TenantV1;
}

function bindingHost(uri: string): string {
  return uri.replace(/^pubky:\/\//, "").split("/")[0] ?? "homeserver";
}

export function createTenantResolver(
  reader: PublicHomeserverReader,
  opts?: {
    cacheMs?: number;
    now?: () => number;
    fetchLimiter?: KeyedLimiter;
    logEvent?: (event: string) => void;
  },
): TenantResolver {
  const successCacheMs = opts?.cacheMs ?? PUBCHI_TENANT_CACHE_MS;
  const now = opts?.now ?? Date.now;
  const fetchLimiter =
    opts?.fetchLimiter ?? memoryKeyedLimiter({ rps: ASKER_FETCH_RPS, burst: ASKER_FETCH_BURST, now });
  const logEvent = opts?.logEvent ?? ((event: string) => log.info({ event }, event));
  const cache = new Map<string, CacheEntry>();
  const delegationCache = new Map<string, { at: number; result: DelegationResolve }>();

  function ttlFor(result: TenantResolve): number {
    if (!result.ok && result.code === "UPSTREAM_UNAVAILABLE") return TENANT_NEGATIVE_CACHE_MS;
    if (!result.ok) return TENANT_MISS_CACHE_MS;
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

  async function fetchObject(uri: string): Promise<
    { ok: true; status: number; body: unknown } | TenantFail
  > {
    try {
      const fetched = await reader.getJson(uri);
      if (fetched.status === 200 || fetched.status === 404) return { ok: true, ...fetched };
      return {
        ok: false,
        code: "UPSTREAM_UNAVAILABLE",
        cause: `homeserver_http_${fetched.status}`,
        upstream_host: bindingHost(uri),
        upstream_status: fetched.status,
      };
    } catch {
      return {
        ok: false,
        code: "UPSTREAM_UNAVAILABLE",
        cause: "homeserver_read_failed",
        upstream_host: bindingHost(uri),
        upstream_status: 0,
      };
    }
  }

  return {
    async resolve(asker: string, bot: string): Promise<TenantResolve> {
      const key = asker;
      const hit = cache.get(key);
      const t = now();
      if (hit && t - hit.at < ttlFor(hit.result)) {
        if (hit.result.ok && hit.result.tenant.bot !== bot) return { ok: false, code: "BOT_MISMATCH" };
        if (!hit.result.ok && hit.requestedBot !== bot) cache.delete(key);
        else return hit.result;
      }
      // Bound outbound fetches per victim asker; cache hits above are free.
      if (!fetchLimiter.take(asker)) return fetchLimited();

      const canonical = await fetchObject(botUri(asker));
      let result: TenantResolve;
      if (!canonical.ok) {
        result = canonical;
      } else if (canonical.status === 404) {
        const legacy = await fetchObject(ownerBindingUri(asker, bot));
        if (!legacy.ok) {
          result = legacy;
        } else if (legacy.status === 404) {
          result = { ok: false, code: "TENANT_NOT_ENROLLED" };
        } else {
          const binding = parseOwnerBindingV1(legacy.body);
          if (!binding.ok) result = { ok: false, code: binding.code };
          else if (binding.value.owner !== asker) result = { ok: false, code: "ASKER_MISMATCH" };
          else if (binding.value.bot !== bot) result = { ok: false, code: "BOT_MISMATCH" };
          else if (binding.value.status !== "active") result = { ok: false, code: "TENANT_NOT_ENROLLED" };
          else {
            logEvent("legacy_binding_without_bot_json");
            result = {
              ok: true,
              tenant: tenantFromBinding(
                asker,
                bot,
                "read-only",
                binding.value.created_at,
                binding.value.updated_at,
              ),
            };
          }
        }
      } else {
        const parsedBot = parsePubchiBotV1(canonical.body);
        if (!parsedBot.ok) {
          result = { ok: false, code: parsedBot.code };
        } else if (parsedBot.value.owner !== asker) {
          result = { ok: false, code: "ASKER_MISMATCH" };
        } else if (parsedBot.value.bot !== bot) {
          result = { ok: false, code: "BOT_MISMATCH" };
        } else {
          const binding = await fetchObject(ownerBindingUri(asker, parsedBot.value.bot));
          if (!binding.ok) {
            result = binding;
          } else if (binding.status === 404) {
            result = { ok: false, code: "TENANT_NOT_ENROLLED" };
          } else {
            const parsedBinding = parseOwnerBindingV1(binding.body);
            if (!parsedBinding.ok) result = { ok: false, code: parsedBinding.code };
            else if (parsedBinding.value.owner !== asker) result = { ok: false, code: "ASKER_MISMATCH" };
            else if (parsedBinding.value.bot !== parsedBot.value.bot) result = { ok: false, code: "BOT_MISMATCH" };
            else if (
              parsedBinding.value.status !== "active" ||
              parsedBinding.value.key_generation !== parsedBot.value.key_generation
            ) {
              result = { ok: false, code: "TENANT_NOT_ENROLLED" };
            } else {
              const config = await fetchObject(configUri(asker));
              if (!config.ok) {
                result = config;
              } else {
                let configTier: Tier = "read-only";
                let updatedAt = parsedBinding.value.updated_at;
                if (config.status === 200) {
                  const parsedConfig = parsePubchiConfigV1(config.body);
                  if (!parsedConfig.ok) result = { ok: false, code: parsedConfig.code };
                  else if (parsedConfig.value.owner !== asker) result = { ok: false, code: "ASKER_MISMATCH" };
                  else if (parsedConfig.value.bot !== parsedBot.value.bot) result = { ok: false, code: "BOT_MISMATCH" };
                  else {
                    configTier = parsedConfig.value.tier;
                    updatedAt = parsedConfig.value.updated_at;
                    const tier = effectiveTier({
                      config_tier: configTier,
                      credential_tier: PUBCHI_V1_TIER_CEILING,
                      switch_tier: "autonomous",
                      budget_tier: budgetTier(configTier),
                    });
                    if (configTier === "autonomous" && tier !== "autonomous") {
                      logEvent("autonomous_tier_capped_at_assisted");
                    }
                    result = {
                      ok: true,
                      tenant: tenantFromBinding(
                        asker,
                        parsedBot.value.bot,
                        tier,
                        parsedBinding.value.created_at,
                        updatedAt,
                      ),
                    };
                  }
                } else {
                  result = {
                    ok: true,
                    tenant: tenantFromBinding(
                      asker,
                      parsedBot.value.bot,
                      "read-only",
                      parsedBinding.value.created_at,
                      updatedAt,
                    ),
                  };
                }
              }
            }
          }
        }
      }
      cappedSet(cache, TENANT_CACHE_MAX_ENTRIES, ttlFor, key, { at: t, result, requestedBot: bot });
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
