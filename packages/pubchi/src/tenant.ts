import {
  ownerBindingUri,
  parseOwnerBindingV1,
  parseTenantV1,
  PHASE0_BRAIN,
  PHASE0_BUDGETS,
  PHASE0_TIER,
  type TenantV1,
} from "../pubchi-schemas/index.js";
import { PUBCHI_TENANT_CACHE_MS } from "./env.js";
import type { PublicHomeserverReader } from "./homeserver-read.js";
import type { ServiceErrorCode } from "./codes.js";

export type TenantResolve = { ok: true; tenant: TenantV1 } | { ok: false; code: ServiceErrorCode };

type CacheEntry = { at: number; result: TenantResolve };

export type TenantResolver = {
  resolve(asker: string, bot: string): Promise<TenantResolve>;
  clear(): void;
};

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

export function createTenantResolver(
  reader: PublicHomeserverReader,
  opts?: { cacheMs?: number; now?: () => number },
): TenantResolver {
  const cacheMs = opts?.cacheMs ?? PUBCHI_TENANT_CACHE_MS;
  const now = opts?.now ?? Date.now;
  const cache = new Map<string, CacheEntry>();

  return {
    async resolve(asker: string, bot: string): Promise<TenantResolve> {
      const key = `${asker}:${bot}`;
      const hit = cache.get(key);
      const t = now();
      if (hit && t - hit.at < cacheMs) return hit.result;
      let fetched;
      try {
        fetched = await reader.getJson(ownerBindingUri(asker, bot));
      } catch {
        return { ok: false, code: "UPSTREAM_UNAVAILABLE" };
      }
      if (fetched.status === 404) {
        const result: TenantResolve = { ok: false, code: "TENANT_NOT_ENROLLED" };
        cache.set(key, { at: t, result });
        return result;
      }
      if (fetched.status !== 200) return { ok: false, code: "UPSTREAM_UNAVAILABLE" };
      const result = parseEnrollment(fetched.body, asker, bot);
      cache.set(key, { at: t, result });
      return result;
    },
    clear() {
      cache.clear();
    },
  };
}

export { parseEnrollment };
