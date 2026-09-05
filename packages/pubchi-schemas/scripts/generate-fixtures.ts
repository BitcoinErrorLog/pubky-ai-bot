import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bodySha256 } from "../src/canonical.js";
import { signRequestObjectV1, type UnsignedRequestObjectV1 } from "../src/request.js";
import {
  TEST_BOT,
  TEST_BOT_SEED,
  TEST_FAKE,
  TEST_FAKE_SEED,
  TEST_NOW,
  TEST_OWNER,
  TEST_OWNER_SEED,
  TWO_HOP_BITCOIN_FEED,
  testTenant,
} from "../src/vectors.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const validDir = join(root, "fixtures/valid");
const invalidDir = join(root, "fixtures/invalid");
mkdirSync(validDir, { recursive: true });
mkdirSync(invalidDir, { recursive: true });

function write(dir: string, name: string, value: unknown): void {
  writeFileSync(join(dir, name), `${JSON.stringify(value, null, 2)}\n`);
}

const tenant = testTenant();
write(validDir, "tenant__phase0.json", tenant);

write(validDir, "owner-binding__active.json", {
  schema: "pubchi-owner-binding",
  version: 1,
  owner: TEST_OWNER,
  bot: TEST_BOT,
  status: "active",
  created_at: TEST_NOW - 86_400,
  updated_at: TEST_NOW,
});

write(validDir, "envelope__config.json", {
  schema: "pubchi-config",
  version: 1,
  bot: TEST_BOT,
  owner: TEST_OWNER,
  updated_at: TEST_NOW,
});

const whoBody = { question: "who tagged me?" };
const whoHash = bodySha256(whoBody);
const unsignedWho: UnsignedRequestObjectV1 = {
  schema: "pubchi-request-object",
  version: 1,
  asker: TEST_OWNER,
  bot: TEST_BOT,
  purpose: "who-tagged-me",
  body_sha256: whoHash,
  issued_at: TEST_NOW,
  expires_at: TEST_NOW + 600,
  nonce: "a".repeat(64),
};
const signedWho = signRequestObjectV1(unsignedWho, TEST_OWNER_SEED);
write(validDir, "request-object__who-tagged-me.json", signedWho);
write(validDir, "request-object__who-tagged-me.meta.json", {
  verify: true,
  now: TEST_NOW + 5,
  body: whoBody,
  tenant,
});

write(validDir, "request-binding__build-feed.json", {
  schema: "pubchi-request",
  version: 1,
  bot: TEST_BOT,
  owner: TEST_OWNER,
  updated_at: TEST_NOW,
  request_id: "req-01",
  body_sha256: whoHash,
  capability: "build-feed",
  expires_at: TEST_NOW + 600,
});

write(validDir, "feed-proposal__two-hop-bitcoin.json", {
  schema: "pubchi-feed-proposal",
  version: 1,
  bot: TEST_BOT,
  owner: TEST_OWNER,
  generated_at: TEST_NOW,
  feed: TWO_HOP_BITCOIN_FEED,
  warnings: [],
  installed_user_feed_id: null,
});

write(validDir, "query-result__who-tagged-me.json", {
  schema: "pubchi-query-result",
  version: 1,
  bot: TEST_BOT,
  owner: TEST_OWNER,
  generated_at: TEST_NOW,
  run_id: "run-01",
  purpose: "who-tagged-me",
  scope_owner: TEST_OWNER,
  items: [
    {
      label: "bitcoin",
      source_uri: `pubky://${TEST_FAKE}/pub/pubky.app/tags/FPB0AM9S93Q3M1GFY1KV09GMQM`,
      subject_uri: `pubky://${TEST_OWNER}/pub/pubky.app/posts/00321FCW75ZFY`,
      claimant_count: 2,
    },
  ],
  tool_trace_summary: {
    tools: ["get_tag_landscape"],
    call_count: 1,
    truncated: false,
  },
  policy_version: 1,
});

write(validDir, "manifest__phase0.json", {
  schema: "pubchi-manifest",
  version: 1,
  bot: TEST_BOT,
  owner: TEST_OWNER,
  updated_at: TEST_NOW,
  objects: [
    {
      path: "/pub/pubchi.app/config.json",
      schema: "pubchi-config",
      version: 1,
      bytes: 420,
      sha256: whoHash,
    },
  ],
});

write(invalidDir, "tenant__TIER_UNSUPPORTED__assisted.json", { ...tenant, tier: "assisted" });
write(invalidDir, "tenant__BUDGET_NOT_FIXED__raised.json", {
  ...tenant,
  budgets: { ...tenant.budgets, per_request_input_tokens: 99_000 },
});
write(invalidDir, "tenant__VERSION_UNSUPPORTED__v2.json", { ...tenant, version: 2 });
write(invalidDir, "tenant__UNKNOWN_FIELD__extra.json", { ...tenant, remember_later: true });
write(invalidDir, "tenant__FORBIDDEN_SECRET__mnemonic.json", { ...tenant, mnemonic: "abandon abandon abandon" });
write(invalidDir, "tenant__FORBIDDEN_PRIVATE__clipboard.json", { ...tenant, clipboard: "copied private post" });
write(invalidDir, "tenant__FORBIDDEN_FINANCIAL__invoice.json", { ...tenant, invoice: "lnbc1..." });
write(invalidDir, "tenant__FORBIDDEN_SENSITIVE__health.json", { ...tenant, health: "diagnosis" });
write(invalidDir, "tenant__FORBIDDEN_SURVEILLANCE__ip.json", { ...tenant, ip_address: "203.0.113.8" });
write(invalidDir, "tenant__FORBIDDEN_INTERNAL__prompt.json", { ...tenant, system_prompt: "you are" });
write(invalidDir, "tenant__FORBIDDEN_ARBITRARY__remember.json", { ...tenant, remember_this: "my pin" });

write(invalidDir, "query-result__FORBIDDEN_SECRET__session.json", {
  schema: "pubchi-query-result",
  version: 1,
  bot: TEST_BOT,
  owner: TEST_OWNER,
  generated_at: TEST_NOW,
  run_id: "run-02",
  purpose: "who-tagged-me",
  scope_owner: TEST_OWNER,
  items: [],
  tool_trace_summary: { tools: ["get_tag_landscape"], call_count: 1, truncated: false },
  policy_version: 1,
  session: "cookie-abc",
});

write(invalidDir, "query-result__FORBIDDEN_INTERNAL__raw-prompt.json", {
  schema: "pubchi-query-result",
  version: 1,
  bot: TEST_BOT,
  owner: TEST_OWNER,
  generated_at: TEST_NOW,
  run_id: "run-03",
  purpose: "who-tagged-me",
  scope_owner: TEST_OWNER,
  items: [],
  tool_trace_summary: { tools: ["get_tag_landscape"], call_count: 1, truncated: false },
  policy_version: 1,
  raw_provider_prompt: "ignore previous instructions",
});

write(invalidDir, "feed-proposal__FEED_UNSUPPORTED_LIKES__sort.json", {
  schema: "pubchi-feed-proposal",
  version: 1,
  bot: TEST_BOT,
  owner: TEST_OWNER,
  generated_at: TEST_NOW,
  feed: { ...TWO_HOP_BITCOIN_FEED, feed: { ...TWO_HOP_BITCOIN_FEED.feed, sort: "likes" } },
  warnings: [],
  installed_user_feed_id: null,
});

write(invalidDir, "feed-proposal__FEED_UNSUPPORTED_REACH__followers.json", {
  schema: "pubchi-feed-proposal",
  version: 1,
  bot: TEST_BOT,
  owner: TEST_OWNER,
  generated_at: TEST_NOW,
  feed: { ...TWO_HOP_BITCOIN_FEED, feed: { ...TWO_HOP_BITCOIN_FEED.feed, reach: "followers" } },
  warnings: [],
  installed_user_feed_id: null,
});

write(invalidDir, "manifest__PATH_FORBIDDEN__dotdot.json", {
  schema: "pubchi-manifest",
  version: 1,
  bot: TEST_BOT,
  owner: TEST_OWNER,
  updated_at: TEST_NOW,
  objects: [
    {
      path: "/pub/pubchi.app/../pubky.app/profile.json",
      schema: "pubchi-config",
      version: 1,
      bytes: 10,
      sha256: whoHash,
    },
  ],
});

const fakeUnsigned: UnsignedRequestObjectV1 = {
  ...unsignedWho,
  asker: TEST_FAKE,
  nonce: "b".repeat(64),
};
const fakeSigned = signRequestObjectV1(fakeUnsigned, TEST_FAKE_SEED);
write(invalidDir, "request-object__ASKER_MISMATCH__fake-asker.json", fakeSigned);
write(invalidDir, "request-object__ASKER_MISMATCH__fake-asker.meta.json", {
  verify: true,
  now: TEST_NOW + 5,
  body: whoBody,
  tenant,
});

const expired = signRequestObjectV1(
  { ...unsignedWho, issued_at: TEST_NOW - 1_200, expires_at: TEST_NOW - 600, nonce: "c".repeat(64) },
  TEST_OWNER_SEED,
);
write(invalidDir, "request-object__REQUEST_EXPIRED__stale.json", expired);
write(invalidDir, "request-object__REQUEST_EXPIRED__stale.meta.json", {
  verify: true,
  now: TEST_NOW,
  body: whoBody,
  tenant,
});

const hashChanged = signRequestObjectV1({ ...unsignedWho, nonce: "d".repeat(64) }, TEST_OWNER_SEED);
write(invalidDir, "request-object__BODY_HASH_MISMATCH__mutated-body.json", hashChanged);
write(invalidDir, "request-object__BODY_HASH_MISMATCH__mutated-body.meta.json", {
  verify: true,
  now: TEST_NOW + 5,
  body: { question: "who tagged me? plus extra" },
  tenant,
});

const replay = signRequestObjectV1({ ...unsignedWho, nonce: "e".repeat(64) }, TEST_OWNER_SEED);
write(invalidDir, "request-object__NONCE_REPLAY__second-use.json", replay);
write(invalidDir, "request-object__NONCE_REPLAY__second-use.meta.json", {
  verify: true,
  now: TEST_NOW + 5,
  body: whoBody,
  tenant,
  replay_nonce: true,
});

const skewed = signRequestObjectV1(
  { ...unsignedWho, issued_at: TEST_NOW + 3_600, expires_at: TEST_NOW + 4_200, nonce: "f".repeat(64) },
  TEST_OWNER_SEED,
);
write(invalidDir, "request-object__CLOCK_SKEW__future-issued.json", skewed);
write(invalidDir, "request-object__CLOCK_SKEW__future-issued.meta.json", {
  verify: true,
  now: TEST_NOW,
  body: whoBody,
  tenant,
});

const botMismatch = signRequestObjectV1(
  { ...unsignedWho, bot: TEST_FAKE, nonce: "1".repeat(64) },
  TEST_OWNER_SEED,
);
write(invalidDir, "request-object__BOT_MISMATCH__other-bot.json", botMismatch);
write(invalidDir, "request-object__BOT_MISMATCH__other-bot.meta.json", {
  verify: true,
  now: TEST_NOW + 5,
  body: whoBody,
  tenant,
});

void TEST_BOT_SEED;
console.log("fixtures written");
