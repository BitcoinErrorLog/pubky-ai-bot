import { z } from "zod";
import { err, ok, type ParseResult } from "./codes.js";
import { fromZod, zPubky, zUnix, zVersion1 } from "./zod.js";

export const PHASE0_TIER = "read-only" as const;
export const TIERS = ["read-only", "assisted", "autonomous"] as const;
export type Tier = (typeof TIERS)[number];

export const PHASE0_BRAIN = {
  adapter: "vercel-ai",
  execution: "synonym-hosted",
  provider_id: "moonshot",
  model_id: "kimi-k3",
  endpoint: null,
} as const;

export const TIER_BUDGETS = {
  "read-only": {
    per_request_input_tokens: 8_000,
    per_request_output_tokens: 2_000,
    per_request_wall_clock_ms: 30_000,
    per_owner_hourly_tokens: 50_000,
    per_owner_utc_day_tokens: 200_000,
    per_tenant_scout_queries: 20,
    per_tenant_scout_rows: 200,
    per_tenant_web_calls: 0,
    proactive_suggestions_per_day: 0,
  },
  assisted: {
    per_request_input_tokens: 8_000,
    per_request_output_tokens: 4_000,
    per_request_wall_clock_ms: 30_000,
    per_owner_hourly_tokens: 50_000,
    per_owner_utc_day_tokens: 200_000,
    per_tenant_scout_queries: 20,
    per_tenant_scout_rows: 200,
    per_tenant_web_calls: 0,
    proactive_suggestions_per_day: 0,
  },
  autonomous: {
    per_request_input_tokens: 8_000,
    per_request_output_tokens: 4_000,
    per_request_wall_clock_ms: 30_000,
    per_owner_hourly_tokens: 50_000,
    per_owner_utc_day_tokens: 200_000,
    per_tenant_scout_queries: 20,
    per_tenant_scout_rows: 200,
    per_tenant_web_calls: 0,
    proactive_suggestions_per_day: 3,
  },
} as const satisfies Record<Tier, Record<string, number>>;

export const PHASE0_BUDGETS = TIER_BUDGETS["read-only"];

const BrainRefV1Schema = z
  .object({
    adapter: z.literal(PHASE0_BRAIN.adapter),
    execution: z.literal(PHASE0_BRAIN.execution),
    provider_id: z.literal(PHASE0_BRAIN.provider_id),
    model_id: z.literal(PHASE0_BRAIN.model_id),
    endpoint: z.literal(null),
  })
  .strict();

function budgetsFor<T extends Tier>(tier: T) {
  const budgets = TIER_BUDGETS[tier];
  return z
    .object({
      per_request_input_tokens: z.literal(budgets.per_request_input_tokens),
      per_request_output_tokens: z.literal(budgets.per_request_output_tokens),
      per_request_wall_clock_ms: z.literal(budgets.per_request_wall_clock_ms),
      per_owner_hourly_tokens: z.literal(budgets.per_owner_hourly_tokens),
      per_owner_utc_day_tokens: z.literal(budgets.per_owner_utc_day_tokens),
      per_tenant_scout_queries: z.literal(budgets.per_tenant_scout_queries),
      per_tenant_scout_rows: z.literal(budgets.per_tenant_scout_rows),
      per_tenant_web_calls: z.literal(budgets.per_tenant_web_calls),
      proactive_suggestions_per_day: z.literal(budgets.proactive_suggestions_per_day),
    })
    .strict();
}

function tenantFor<T extends Tier>(tier: T) {
  return z.object({
    schema: z.literal("pubchi-tenant"),
    version: zVersion1,
    bot: zPubky,
    owner: zPubky,
    tier: z.literal(tier),
    brain: BrainRefV1Schema,
    budgets: budgetsFor(tier),
    created_at: zUnix,
    updated_at: zUnix,
  }).strict();
}

export const TenantV1Schema = z.discriminatedUnion("tier", [
  tenantFor("read-only"),
  tenantFor("assisted"),
  tenantFor("autonomous"),
]);

export type TenantV1 = z.infer<typeof TenantV1Schema>;

export function parseTenantV1(input: unknown): ParseResult<TenantV1> {
  const result = fromZod(TenantV1Schema, input);
  if (!result.ok) return result;
  if (result.value.updated_at < result.value.created_at) return err("SCHEMA_INVALID");
  return ok(result.value);
}

export const OwnerBindingV1Schema = z
  .object({
    schema: z.literal("pubchi-owner-binding"),
    version: zVersion1,
    owner: zPubky,
    bot: zPubky,
    status: z.enum(["active", "revoked"]),
    key_generation: z.number().int().min(1).optional(),
    created_at: zUnix,
    updated_at: zUnix,
  })
  .strict();

export type OwnerBindingV1 = z.infer<typeof OwnerBindingV1Schema>;

export function parseOwnerBindingV1(input: unknown): ParseResult<OwnerBindingV1> {
  return fromZod(OwnerBindingV1Schema, input);
}
