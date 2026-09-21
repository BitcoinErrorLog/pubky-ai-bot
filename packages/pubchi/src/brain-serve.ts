import {
  PHASE0_BRAIN,
  canonicalJson,
  type BrainRefV1,
  type TenantV1,
} from "../pubchi-schemas/index.js";
import { createBrain } from "../bot-kit/brain/create.js";
import {
  BrainEgressError,
  hostnameFromBaseUrl,
  isAllowedBrainHost,
  isLoopbackHost,
} from "../bot-kit/brain/egress.js";
import type { Brain } from "../bot-kit/brain/types.js";
import type { ServiceErrorCode } from "./codes.js";

/** Public descriptor URL cap. Credentials never appear in the descriptor. */
export const BRAIN_ENDPOINT_MAX_BYTES = 2_048;

export type BrainServeFail = {
  ok: false;
  code: Extract<ServiceErrorCode, "BRAIN_FORBIDDEN" | "BRAIN_UNAVAILABLE">;
  cause: string;
};
export type BrainServeOk = { ok: true; brain: Brain };
export type BrainServeResult = BrainServeOk | BrainServeFail;
export type BrainResolver = (tenant: TenantV1) => BrainServeResult;

export type BrainServeEnv = {
  deploymentBrain: Brain;
  hostedModel?: string;
  hostedApiKey?: string;
  hostedBaseUrl?: string;
  hostedTemperature?: number;
  selfHostedApiKey?: string;
  egressDangerous?: boolean;
  timeoutMs?: number;
};

function fail(code: BrainServeFail["code"], cause: string): BrainServeFail {
  return { ok: false, code, cause };
}

function isHostedMoonshot(ref: BrainRefV1): boolean {
  return ref.execution === "synonym-hosted" && ref.provider_id === "moonshot" && ref.endpoint === null;
}

/**
 * Strict serving checks beyond the public schema: schemes, loopback HTTP,
 * existing egress allowlist (Moonshot host or loopback), no URL credentials,
 * no query/hash, size cap. Does not add a new outbound host allowlist.
 */
export function validateServedBrainRef(
  ref: BrainRefV1,
  opts?: { egressDangerous?: boolean },
): BrainServeFail | { ok: true; value: BrainRefV1 } {
  if (ref.adapter !== "vercel-ai") return fail("BRAIN_FORBIDDEN", "brain_adapter");
  if ((ref.execution === "self-hosted") !== (ref.endpoint !== null)) {
    return fail("BRAIN_FORBIDDEN", "brain_execution_endpoint");
  }
  if (ref.provider_id === "moonshot" && ref.execution !== "synonym-hosted") {
    return fail("BRAIN_FORBIDDEN", "brain_pairing");
  }
  if (ref.provider_id !== "moonshot" && ref.execution !== "self-hosted") {
    return fail("BRAIN_FORBIDDEN", "brain_pairing");
  }
  if (ref.endpoint === null) return { ok: true, value: ref };

  const encoded = new TextEncoder().encode(ref.endpoint);
  if (encoded.byteLength > BRAIN_ENDPOINT_MAX_BYTES) return fail("BRAIN_FORBIDDEN", "brain_endpoint_size");

  let parsed: URL;
  try {
    parsed = new URL(ref.endpoint);
  } catch {
    return fail("BRAIN_FORBIDDEN", "brain_endpoint_url");
  }
  if (parsed.username || parsed.password) return fail("BRAIN_FORBIDDEN", "brain_endpoint_credentials");
  if (parsed.search !== "" || parsed.hash !== "") return fail("BRAIN_FORBIDDEN", "brain_endpoint_credentials");
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return fail("BRAIN_FORBIDDEN", "brain_endpoint_scheme");
  }

  let host: string;
  try {
    host = hostnameFromBaseUrl(ref.endpoint);
  } catch {
    return fail("BRAIN_FORBIDDEN", "brain_endpoint_url");
  }
  const loopback = isLoopbackHost(host);
  if (parsed.protocol === "http:" && !loopback) return fail("BRAIN_FORBIDDEN", "brain_endpoint_scheme");
  if (ref.provider_id === "ollama" && !loopback) return fail("BRAIN_FORBIDDEN", "brain_ollama_loopback");
  if (!isAllowedBrainHost(host) && !opts?.egressDangerous) return fail("BRAIN_FORBIDDEN", "brain_egress");
  return { ok: true, value: ref };
}

function withTimeout(brain: Brain, timeoutMs: number): Brain {
  return {
    ...brain,
    generate: async (args) => {
      const timeout = AbortSignal.timeout(Math.max(1, timeoutMs));
      const abortSignal = args.abortSignal ? AbortSignal.any([args.abortSignal, timeout]) : timeout;
      return brain.generate({ ...args, abortSignal });
    },
  };
}

function mapCreateError(error: unknown): BrainServeFail {
  if (error instanceof BrainEgressError) return fail("BRAIN_FORBIDDEN", "brain_egress");
  const message = error instanceof Error ? error.message : "brain_create";
  if (/egress/i.test(message)) return fail("BRAIN_FORBIDDEN", "brain_egress");
  if (/api key|base URL/i.test(message)) return fail("BRAIN_UNAVAILABLE", "brain_credentials");
  return fail("BRAIN_UNAVAILABLE", "brain_create");
}

function constructBrain(ref: BrainRefV1, env: BrainServeEnv): BrainServeResult {
  try {
    if (isHostedMoonshot(ref)) {
      const hostedModel = env.hostedModel ?? PHASE0_BRAIN.model_id;
      if (ref.model_id === hostedModel) {
        return { ok: true, brain: env.deploymentBrain };
      }
      if (!env.hostedApiKey?.trim()) return fail("BRAIN_UNAVAILABLE", "brain_credentials");
      return {
        ok: true,
        brain: createBrain({
          id: "moonshot",
          model: ref.model_id,
          apiKey: env.hostedApiKey,
          baseUrl: env.hostedBaseUrl,
          temperature: env.hostedTemperature,
          egressDangerous: env.egressDangerous,
        }),
      };
    }
    if (ref.provider_id === "ollama") {
      return {
        ok: true,
        brain: createBrain({
          id: "ollama",
          model: ref.model_id,
          baseUrl: ref.endpoint ?? undefined,
          egressDangerous: env.egressDangerous,
        }),
      };
    }
    const selfHostedKey = env.selfHostedApiKey?.trim();
    if (!selfHostedKey) return fail("BRAIN_UNAVAILABLE", "brain_credentials");
    return {
      ok: true,
      brain: createBrain({
        id: "openai-compatible",
        model: ref.model_id,
        apiKey: selfHostedKey,
        baseUrl: ref.endpoint ?? undefined,
        egressDangerous: env.egressDangerous,
      }),
    };
  } catch (error) {
    return mapCreateError(error);
  }
}

export function servePubchiBrain(ref: BrainRefV1, env: BrainServeEnv): BrainServeResult {
  const validated = validateServedBrainRef(ref, { egressDangerous: env.egressDangerous === true });
  if (!validated.ok) return validated;
  const constructed = constructBrain(validated.value, env);
  if (!constructed.ok) return constructed;
  const timeoutMs = env.timeoutMs ?? 30_000;
  return { ok: true, brain: withTimeout(constructed.brain, timeoutMs) };
}

export function createPubchiBrainServe(env: Omit<BrainServeEnv, "timeoutMs">): BrainResolver {
  const cache = new Map<string, Brain>();
  return (tenant) => {
    const validated = validateServedBrainRef(tenant.brain, { egressDangerous: env.egressDangerous === true });
    if (!validated.ok) return validated;
    const key = canonicalJson(validated.value);
    let brain = cache.get(key);
    if (!brain) {
      const constructed = constructBrain(validated.value, env);
      if (!constructed.ok) return constructed;
      brain = constructed.brain;
      cache.set(key, brain);
    }
    return { ok: true, brain: withTimeout(brain, tenant.budgets.per_request_wall_clock_ms) };
  };
}

export function defaultPubchiBrainResolver(deploymentBrain: Brain): BrainResolver {
  return createPubchiBrainServe({
    deploymentBrain,
    hostedModel: PHASE0_BRAIN.model_id,
    hostedApiKey: process.env.JEB_MODEL_API_KEY,
    hostedBaseUrl: process.env.JEB_MODEL_BASE_URL,
    selfHostedApiKey: process.env.PUBCHI_SELF_HOSTED_BRAIN_API_KEY,
    egressDangerous: process.env.JEB_BRAIN_EGRESS_DANGEROUS === "1",
  });
}

export const PROVIDER_STATE_KEYS = [
  "thread_id",
  "assistant_id",
  "vector_store_id",
  "vector_store",
  "conversation_id",
  "prompt_cache_key",
  "cache_id",
  "resume",
] as const;

export function providerStateKeysIn(value: unknown, found: string[] = []): string[] {
  if (value === null || typeof value !== "object") return found;
  if (Array.isArray(value)) {
    for (const item of value) providerStateKeysIn(item, found);
    return found;
  }
  for (const [key, next] of Object.entries(value as Record<string, unknown>)) {
    if ((PROVIDER_STATE_KEYS as readonly string[]).includes(key) && !found.includes(key)) found.push(key);
    providerStateKeysIn(next, found);
  }
  return found;
}
