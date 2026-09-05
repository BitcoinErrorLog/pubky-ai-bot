import { Keypair } from "@synonymdev/pubky";
import { PHASE0_BRAIN, PHASE0_BUDGETS, type TenantV1 } from "./tenant.js";

/** Test-only seeds. Not production key material. */
export const TEST_OWNER_SEED = new Uint8Array(32).fill(0x11);
export const TEST_BOT_SEED = new Uint8Array(32).fill(0x22);
export const TEST_FAKE_SEED = new Uint8Array(32).fill(0x33);

export const TEST_OWNER = Keypair.fromSecret(TEST_OWNER_SEED).publicKey.z32();
export const TEST_BOT = Keypair.fromSecret(TEST_BOT_SEED).publicKey.z32();
export const TEST_FAKE = Keypair.fromSecret(TEST_FAKE_SEED).publicKey.z32();

export const TEST_NOW = 1_788_600_000;

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
