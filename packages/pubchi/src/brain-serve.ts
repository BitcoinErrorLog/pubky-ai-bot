import {
  PHASE0_BRAIN,
  canonicalJson,
  sha256Hex,
  type BrainRefV1,
  type TenantV1,
} from "../pubchi-schemas/index.js";
import { createBrain } from "../bot-kit/brain/create.js";
import { BrainEgressError, hostnameFromBaseUrl } from "../bot-kit/brain/egress.js";
import type { Brain } from "../bot-kit/brain/types.js";
import type { ServiceErrorCode } from "./codes.js";

/** Public descriptor URL cap. Credentials never appear in the descriptor. */
export const BRAIN_ENDPOINT_MAX_BYTES = 2_048;

/** Tenant self-hosted hosts after URL hostname canonicalization. Not 127/8. */
export const TENANT_LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

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
  /** Deployment (synonym-hosted) Moonshot only. Never applied to tenant URLs. */
  egressDangerous?: boolean;
  timeoutMs?: number;
};

function fail(code: BrainServeFail["code"], cause: string): BrainServeFail {
  return { ok: false, code, cause };
}

function isHostedMoonshot(ref: BrainRefV1): boolean {
  return ref.execution === "synonym-hosted" && ref.provider_id === "moonshot" && ref.endpoint === null;
}

export function isTenantLoopbackHost(host: string): boolean {
  return TENANT_LOOPBACK_HOSTS.has(host.toLowerCase());
}

/** Shared self-hosted bearer is attached only to openai-compatible loopback URLs. */
function openaiCompatibleLoopbackEndpoint(ref: BrainRefV1): BrainServeFail | { ok: true; endpoint: string } {
  if (ref.provider_id !== "openai-compatible") return fail("BRAIN_FORBIDDEN", "brain_pairing");
  if (!ref.endpoint) return fail("BRAIN_FORBIDDEN", "brain_execution_endpoint");
  let host: string;
  try {
    host = hostnameFromBaseUrl(ref.endpoint);
  } catch {
    return fail("BRAIN_FORBIDDEN", "brain_endpoint_url");
  }
  if (!isTenantLoopbackHost(host)) return fail("BRAIN_FORBIDDEN", "brain_loopback");
  return { ok: true, endpoint: ref.endpoint };
}

/**
 * Strict serving checks: pairing, size, no URL credentials/query/hash.
 * Self-hosted endpoints are exact loopback hosts only. Moonshot's host
 * allowlist and JEB_BRAIN_EGRESS_DANGEROUS do not apply to tenant URLs.
 */
export function validateServedBrainRef(ref: BrainRefV1): BrainServeFail | { ok: true; value: BrainRefV1 } {
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
  if (!isTenantLoopbackHost(host)) return fail("BRAIN_FORBIDDEN", "brain_loopback");
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
        }),
      };
    }
    const loopback = openaiCompatibleLoopbackEndpoint(ref);
    if (!loopback.ok) return loopback;
    const selfHostedKey = env.selfHostedApiKey?.trim();
    if (!selfHostedKey) return fail("BRAIN_UNAVAILABLE", "brain_credentials");
    return {
      ok: true,
      brain: createBrain({
        id: "openai-compatible",
        model: ref.model_id,
        apiKey: selfHostedKey,
        baseUrl: loopback.endpoint,
      }),
    };
  } catch (error) {
    return mapCreateError(error);
  }
}

export function servePubchiBrain(ref: BrainRefV1, env: BrainServeEnv): BrainServeResult {
  const validated = validateServedBrainRef(ref);
  if (!validated.ok) return validated;
  const constructed = constructBrain(validated.value, env);
  if (!constructed.ok) return constructed;
  const timeoutMs = env.timeoutMs ?? 30_000;
  return { ok: true, brain: withTimeout(constructed.brain, timeoutMs) };
}

export function createPubchiBrainServe(env: Omit<BrainServeEnv, "timeoutMs">): BrainResolver {
  const cache = new Map<string, Brain>();
  const keyFingerprint = env.selfHostedApiKey?.trim() ? sha256Hex(env.selfHostedApiKey.trim()) : "";
  return (tenant) => {
    const validated = validateServedBrainRef(tenant.brain);
    if (!validated.ok) return validated;
    const key = canonicalJson({ ref: validated.value, self_hosted_key: keyFingerprint });
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
