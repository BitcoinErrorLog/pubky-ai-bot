import { withModelFallback } from "../bot-kit/brain/fallback.js";
import { createBrain } from "../bot-kit/brain/create.js";
import type { Brain, BrainId } from "../bot-kit/brain/types.js";
import { PHASE0_BUDGETS } from "../pubchi-schemas/index.js";

/**
 * Same-provider model used once when the pinned hosted brain is overloaded,
 * rate limited, erroring, or silent. Tenant descriptors keep naming the
 * primary model only; the fallback is a deployment concern and never appears
 * in the tenant schema or its canonical hash.
 */
export const PHASE0_BRAIN_FALLBACK = { fallback_model_id: "kimi-k3" } as const;

/** Half the fixed per-request wall clock, so the fallback keeps a usable window. */
export const DEFAULT_FALLBACK_AFTER_MS = Math.floor(PHASE0_BUDGETS.per_request_wall_clock_ms / 2);

const DISABLED = new Set(["off", "none", "false", "0"]);

/**
 * PUBCHI_MODEL_FALLBACK overrides the default; "off" disables it. The default
 * applies only to the hosted Moonshot brain, because its model id is
 * meaningless on any other provider.
 */
export function pubchiFallbackModelId(opts: {
  brain: BrainId;
  primary: string;
  env?: NodeJS.ProcessEnv;
}): string | undefined {
  const raw = (opts.env ?? process.env).PUBCHI_MODEL_FALLBACK?.trim();
  if (raw !== undefined && raw !== "" && DISABLED.has(raw.toLowerCase())) return undefined;
  const chosen = raw ? raw : opts.brain === "moonshot" ? PHASE0_BRAIN_FALLBACK.fallback_model_id : undefined;
  return chosen && chosen !== opts.primary ? chosen : undefined;
}

/** PUBCHI_MODEL_FALLBACK_AFTER_MS, clamped to half the per-request wall clock. */
export function pubchiFallbackAfterMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.PUBCHI_MODEL_FALLBACK_AFTER_MS);
  const wanted = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_FALLBACK_AFTER_MS;
  return Math.min(wanted, DEFAULT_FALLBACK_AFTER_MS);
}

export type PubchiBrainOptions = {
  id: BrainId;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  temperature?: number;
  egressDangerous?: boolean;
  env?: NodeJS.ProcessEnv;
};

/** Deployment brain: the pinned model plus the configured same-provider fallback. */
export function createPubchiDeploymentBrain(opts: PubchiBrainOptions): Brain {
  const make = (model: string): Brain =>
    createBrain({
      id: opts.id,
      model,
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl,
      temperature: opts.temperature,
      egressDangerous: opts.egressDangerous,
    });
  const fallbackModel = pubchiFallbackModelId({ brain: opts.id, primary: opts.model, env: opts.env });
  return withModelFallback(make(opts.model), fallbackModel ? make(fallbackModel) : null, {
    primaryTimeoutMs: pubchiFallbackAfterMs(opts.env),
  });
}
