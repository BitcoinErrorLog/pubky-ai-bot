import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@synonymdev/pubky";
import {
  MemoryNonceStore,
  PHASE0_BRAIN,
  PHASE0_BUDGETS,
  bodySha256,
  signRequestObjectV1,
  type Phase0Purpose,
  type TenantV1,
} from "@pubky/pubchi-schemas";
import type { Brain, NlqRequest, NlqResult, NlqServiceOptions } from "@pubky/bot-kit";
import { nlqResult } from "@pubky/bot-kit";
import type { TenantResolver } from "./tenant.js";
import { memoryTokenBudget, memoryTokenBucket } from "./budget.js";
import type { PubchiListenOptions } from "./http.js";
import type { QueryNlqFn } from "./query.js";

export const TEST_OWNER_SEED = new Uint8Array(32).fill(0x11);
export const TEST_FAKE_SEED = new Uint8Array(32).fill(0x33);
export const TEST_OWNER = Keypair.fromSecret(TEST_OWNER_SEED).publicKey.z32();
export const TEST_FAKE = Keypair.fromSecret(TEST_FAKE_SEED).publicKey.z32();
export const TEST_BOT = Keypair.fromSecret(new Uint8Array(32).fill(0x22)).publicKey.z32();
export const TEST_NOW = 1_788_600_000;

export const TWO_HOP_BITCOIN_FEED = {
  feed: {
    tags: ["bitcoin", "scaling"],
    domain_tags: ["builder"],
    reach: "wot",
    layout: "wide",
    sort: "recent",
    content: "short",
  },
  name: "Bitcoin scaling nearby",
  created_at: TEST_NOW,
};

export function testTenant(overrides: Partial<TenantV1> = {}): TenantV1 {
  return {
    schema: "pubchi-tenant",
    version: 1,
    bot: TEST_BOT,
    owner: TEST_OWNER,
    tier: "read-only",
    brain: { ...PHASE0_BRAIN },
    budgets: { ...PHASE0_BUDGETS },
    created_at: TEST_NOW - 86_400,
    updated_at: TEST_NOW,
    ...overrides,
  };
}

const here = dirname(fileURLToPath(import.meta.url));
const fixturesRoot = existsSync(join(here, "../../pubchi-schemas/fixtures"))
  ? join(here, "../../pubchi-schemas/fixtures")
  : join(here, "../../packages/pubchi-schemas/fixtures");

export function loadFixture(rel: string): unknown {
  return JSON.parse(readFileSync(join(fixturesRoot, rel), "utf8")) as unknown;
}

export function stubTenant(tenant: TenantV1 = testTenant()): TenantResolver {
  return {
    resolve: async () => ({ ok: true, tenant }),
    clear() {},
  };
}

export function dummyNlqOpts(): NlqServiceOptions {
  return {
    cfg: {
      scoutUrl: "http://127.0.0.1:9",
      scoutTimeoutMs: 1000,
      scoutLimitMax: 10,
      scoutEnabled: true,
      scoutRawEnabled: false,
      scoutPerMentionCap: 12,
      scoutDailyCeiling: 400,
      scoutRawPerUserDaily: 8,
      scoutRawGlobalDaily: 40,
      scoutProfilePropMax: 3,
      scoutClaimantCap: 12,
    },
    pool: {} as never,
    tables: {} as never,
    client: {} as never,
  };
}

export function countingBrain(impl: () => Promise<string> | string): { brain: Brain; calls: number } {
  const state = { calls: 0, brain: null as unknown as Brain };
  state.brain = {
    capabilities: {
      name: "mock",
      providerId: "mock",
      supportsTools: false,
      maxContextTokens: 1024,
      samplingDefaults: { temperature: 1 },
    },
    temperature: 1,
    generate: async () => {
      state.calls += 1;
      const text = await impl();
      return { text, response: { messages: [] } };
    },
  };
  return state;
}

export function trackingNlq(impl: (req: NlqRequest) => NlqResult | Promise<NlqResult>): {
  nlq: QueryNlqFn;
  calls: NlqRequest[];
} {
  const calls: NlqRequest[] = [];
  return {
    calls,
    nlq: async (req) => {
      calls.push(req);
      return impl(req);
    },
  };
}

export function happyNlqResult(owner: string): NlqResult {
  return nlqResult({
    outcome: "ok",
    reason: "ok",
    intent: "research_pubky",
    planned: [{ tool: "get_tag_landscape", args: { tag: "bitcoin" } }],
    results: [
      {
        items: [
          {
            label: "bitcoin",
            source_uri: `pubky://n9fzu63meroxfcxccz1budmqbn3e7yj97cy6jjyyoqpamacyod8y/pub/pubky.app/tags/FPB0AM9S93Q3M1GFY1KV09GMQM`,
            subject_uri: `pubky://${owner}/pub/pubky.app/posts/00321FCW75ZFY`,
            claimant_count: 2,
          },
        ],
      },
    ],
  });
}

export function signedRequest(purpose: Phase0Purpose, body: unknown, nonce: string, now = TEST_NOW) {
  return signRequestObjectV1(
    {
      schema: "pubchi-request-object",
      version: 1,
      asker: TEST_OWNER,
      bot: TEST_BOT,
      purpose,
      body_sha256: bodySha256(body),
      issued_at: now,
      expires_at: now + 600,
      nonce,
    },
    TEST_OWNER_SEED,
  );
}

export function baseListenOpts(over: Partial<PubchiListenOptions> = {}): PubchiListenOptions {
  const sharedNonces = new MemoryNonceStore();
  const brain = countingBrain(() => {
    throw new Error("brain must not be called");
  });
  const nlq = trackingNlq(() => happyNlqResult(TEST_OWNER));
  return {
    port: 0,
    bind: "127.0.0.1",
    now: () => TEST_NOW + 5,
    nonceForAsker: () => sharedNonces,
    tenants: stubTenant(),
    budget: memoryTokenBudget({ dailyCeiling: 200_000, perRequestCap: 10_000 }),
    bucket: memoryTokenBucket({ ratePerSec: 100, burst: 100 }),
    nlq: nlq.nlq,
    nlqOpts: dummyNlqOpts(),
    brain: brain.brain,
    ...over,
  };
}

export { MemoryNonceStore };
