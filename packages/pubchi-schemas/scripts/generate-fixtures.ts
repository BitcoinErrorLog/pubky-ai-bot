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
  schema: "pubchi-envelope",
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
      path: "/pub/app.pubchi/v1/config.json",
      schema: "pubchi-config",
      version: 1,
      bytes: 420,
      sha256: whoHash,
    },
  ],
});

write(invalidDir, "tenant__TIER_UNSUPPORTED__assisted.json", { ...tenant, tier: "invalid-tier" });
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
      path: "/pub/app.pubchi/v1/../pubky.app/profile.json",
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

const c5Target = `pubky://${TEST_OWNER}/pub/pubky.app/profile.json`;
const c5Answer = {
  schema: "pubchi-answer",
  version: 1,
  bot: TEST_BOT,
  owner: TEST_OWNER,
  generated_at: TEST_NOW,
  run_id: "c5-fixture",
  purpose: "ask",
  question: "Suggest tags for this user",
  summary: "No safe tag suggestions were found.",
  evidence: [],
  sources: [],
  tool_trace_summary: { tools: [], call_count: 0, truncated: false },
  policy_version: 1,
  section: "tag_suggestions",
  target: { kind: "user", uri: c5Target, snapshot_sha256: null },
  tag_suggestions: [],
  scope: { time: null, graph: { kind: "whole_graph" }, filters: ["target:user"], complete: true },
  basis: "graph",
};
write(validDir, "answer__c5-valid.json", c5Answer);
write(invalidDir, "answer__SCHEMA_INVALID__missing-section.json", { ...c5Answer, section: undefined });
write(invalidDir, "answer__SCHEMA_INVALID__missing-target.json", { ...c5Answer, target: undefined });
write(invalidDir, "answer__SCHEMA_INVALID__kind-path.json", { ...c5Answer, target: { ...c5Answer.target, kind: "post" } });
write(invalidDir, "answer__SCHEMA_INVALID__duplicate-label.json", {
  ...c5Answer,
  target: { ...c5Answer.target, snapshot_sha256: "a".repeat(64) },
  tag_suggestions: [
    { label: "bitcoin", rationale: "x", evidence: [c5Target], already_applied: false, source: "vocab" },
    { label: "bitcoin", rationale: "x", evidence: [c5Target], already_applied: false, source: "vocab" },
  ],
});
write(invalidDir, "answer__SCHEMA_INVALID__rationale-length.json", {
  ...c5Answer,
  target: { ...c5Answer.target, snapshot_sha256: "a".repeat(64) },
  tag_suggestions: [{ label: "bitcoin", rationale: "x".repeat(121), evidence: [c5Target], already_applied: false, source: "vocab" }],
});
write(invalidDir, "answer__SCHEMA_INVALID__evidence.json", {
  ...c5Answer,
  target: { ...c5Answer.target, snapshot_sha256: "a".repeat(64) },
  tag_suggestions: [{ label: "bitcoin", rationale: "x", evidence: ["https://evil.example"], already_applied: false, source: "vocab" }],
});
write(invalidDir, "answer__SCHEMA_INVALID__null-snapshot.json", {
  ...c5Answer,
  tag_suggestions: [{ label: "bitcoin", rationale: "x", evidence: [c5Target], already_applied: false, source: "vocab" }],
});
const c5SuggestionAnswer = {
  ...c5Answer,
  target: { ...c5Answer.target, snapshot_sha256: "a".repeat(64) },
  evidence: [{ kind: "claim", label: "bitcoin", uri: c5Target, claimants: [], claimant_count: 0, in_your_graph: null }],
  tag_suggestions: [{ label: "one-two-three", rationale: "Public evidence.", evidence: [c5Target], already_applied: false, source: "vocab" }],
};
write(validDir, "answer__c5-label-boundaries-valid.json", {
  ...c5SuggestionAnswer,
  tag_suggestions: [{ ...c5SuggestionAnswer.tag_suggestions[0], label: "a".repeat(20) }],
});
write(invalidDir, "answer__SCHEMA_INVALID__label-uppercase.json", {
  ...c5SuggestionAnswer,
  tag_suggestions: [{ ...c5SuggestionAnswer.tag_suggestions[0], label: "Bitcoin" }],
});
write(invalidDir, "answer__SCHEMA_INVALID__label-four-words.json", {
  ...c5SuggestionAnswer,
  tag_suggestions: [{ ...c5SuggestionAnswer.tag_suggestions[0], label: "one-two-three-four" }],
});
write(invalidDir, "answer__SCHEMA_INVALID__label-over-spec-cap.json", {
  ...c5SuggestionAnswer,
  tag_suggestions: [{ ...c5SuggestionAnswer.tag_suggestions[0], label: "a".repeat(21) }],
});
write(invalidDir, "answer__SCHEMA_INVALID__evidence-outside-public.json", {
  ...c5SuggestionAnswer,
  tag_suggestions: [{ ...c5SuggestionAnswer.tag_suggestions[0], evidence: [`pubky://${TEST_OWNER}/priv/app.pubchi/v1/x.json`] }],
});
const otherPublicEvidenceUri = `pubky://${TEST_OWNER}/pub/app.pubchi/v1/evidence.json`;
write(validDir, "answer__c5-evidence-other-public-app-valid.json", {
  ...c5SuggestionAnswer,
  evidence: [{ ...c5SuggestionAnswer.evidence[0], uri: otherPublicEvidenceUri }],
  tag_suggestions: [{ ...c5SuggestionAnswer.tag_suggestions[0], evidence: [otherPublicEvidenceUri] }],
});
const invalidPublicEvidence = (uri: string) => ({
  ...c5SuggestionAnswer,
  evidence: [{ ...c5SuggestionAnswer.evidence[0], uri }],
  tag_suggestions: [{ ...c5SuggestionAnswer.tag_suggestions[0], evidence: [uri] }],
});
write(validDir, "answer__c5-evidence-deep-path-valid.json", {
  ...c5SuggestionAnswer,
  evidence: [{ ...c5SuggestionAnswer.evidence[0], uri: `pubky://${TEST_OWNER}/pub/app.pubchi/v1/evidence/deep.json` }],
  tag_suggestions: [{ ...c5SuggestionAnswer.tag_suggestions[0], evidence: [`pubky://${TEST_OWNER}/pub/app.pubchi/v1/evidence/deep.json`] }],
});
write(invalidDir, "answer__SCHEMA_INVALID__evidence-query.json", invalidPublicEvidence(`${c5Target}?x=1`));
write(invalidDir, "answer__SCHEMA_INVALID__evidence-fragment.json", invalidPublicEvidence(`${c5Target}#frag`));
write(invalidDir, "answer__SCHEMA_INVALID__evidence-dotdot.json", invalidPublicEvidence(`pubky://${TEST_OWNER}/pub/a/../b`));
write(invalidDir, "answer__SCHEMA_INVALID__evidence-double-slash.json", invalidPublicEvidence(`pubky://${TEST_OWNER}/pub/a//b`));
write(invalidDir, "answer__SCHEMA_INVALID__evidence-trailing-slash.json", invalidPublicEvidence(`pubky://${TEST_OWNER}/pub/a/`));
write(invalidDir, "answer__SCHEMA_INVALID__evidence-percent.json", invalidPublicEvidence(`pubky://${TEST_OWNER}/pub/a%2Fb`));
const maxLengthEvidencePrefix = `pubky://${TEST_OWNER}/pub/`;
const maxLengthEvidenceUri = `${maxLengthEvidencePrefix}${"a".repeat(512 - maxLengthEvidencePrefix.length)}`;
write(validDir, "answer__c5-evidence-max-length-valid.json", invalidPublicEvidence(maxLengthEvidenceUri));
write(invalidDir, "answer__SCHEMA_INVALID__evidence-too-long.json", invalidPublicEvidence(`${maxLengthEvidenceUri}a`));
write(invalidDir, "answer__SCHEMA_INVALID__evidence-del-char.json", invalidPublicEvidence(`${c5Target}\x7F`));
write(invalidDir, "answer__SCHEMA_INVALID__evidence-whitespace.json", invalidPublicEvidence(`${c5Target} `));
write(invalidDir, "answer__SCHEMA_INVALID__evidence-backslash.json", invalidPublicEvidence(`pubky://${TEST_OWNER}/pub/a\\b`));
write(invalidDir, "answer__SCHEMA_INVALID__evidence-empty-namespace.json", invalidPublicEvidence(`pubky://${TEST_OWNER}/pub//x`));
write(invalidDir, "answer__SCHEMA_INVALID__evidence-single-dot.json", invalidPublicEvidence(`pubky://${TEST_OWNER}/pub/./x`));
write(invalidDir, "answer__SCHEMA_INVALID__evidence-priv.json", {
  ...c5SuggestionAnswer,
  evidence: [{ ...c5SuggestionAnswer.evidence[0], uri: `pubky://${TEST_OWNER}/priv/app.pubchi/v1/evidence.json` }],
  tag_suggestions: [{ ...c5SuggestionAnswer.tag_suggestions[0], evidence: [`pubky://${TEST_OWNER}/priv/app.pubchi/v1/evidence.json`] }],
});
write(invalidDir, "answer__SCHEMA_INVALID__evidence-non-pubky-scheme.json", {
  ...c5SuggestionAnswer,
  evidence: [{ ...c5SuggestionAnswer.evidence[0], uri: "https://example.com/evidence.json" }],
  tag_suggestions: [{ ...c5SuggestionAnswer.tag_suggestions[0], evidence: ["https://example.com/evidence.json"] }],
});
const c4ThreadUri = `pubky://${TEST_OWNER}/pub/pubky.app/posts/0035NV17R994G`;
write(validDir, "answer__c4-thread-valid.json", {
  schema: "pubchi-answer", version: 1, bot: TEST_BOT, owner: TEST_OWNER, generated_at: TEST_NOW, run_id: "c4-thread",
  purpose: "ask", question: "Summarize this thread", summary: "Thread summary.", evidence: [], sources: [],
  tool_trace_summary: { tools: ["thread"], call_count: 1, truncated: false }, policy_version: 1,
  scope: { time: null, graph: { kind: "whole_graph" }, filters: [`thread:${c4ThreadUri}`], complete: true }, basis: "graph",
});
write(validDir, "answer__scope-filter-160-valid.json", {
  ...c5Answer,
  scope: { ...c5Answer.scope, filters: ["x".repeat(160)] },
});
write(invalidDir, "answer__SCHEMA_INVALID__summary-empty.json", { ...c5Answer, summary: "" });
write(validDir, "answer__sources-https-nexus-valid.json", {
  ...c5Answer,
  sources: ["https://nexus.pubky.app/v0/stream/resources"],
});
write(validDir, "answer__sources-pubky-any-path-valid.json", {
  ...c5Answer,
  sources: [`pubky://${TEST_OWNER}/anything`],
});
write(invalidDir, "answer__SCHEMA_INVALID__sources-http-scheme.json", {
  ...c5Answer,
  sources: ["http://nexus.pubky.app/v0/stream/resources"],
});
write(invalidDir, "answer__SCHEMA_INVALID__basis-knowledge-graph-kind-owner.json", {
  ...c5Answer,
  basis: "knowledge",
  scope: { ...c5Answer.scope, graph: { kind: "owner_network" } },
});
write(invalidDir, "answer__SCHEMA_INVALID__basis-graph-kind-none.json", {
  ...c5Answer,
  basis: "graph",
  scope: { ...c5Answer.scope, graph: { kind: "none" } },
});
write(invalidDir, "answer__SCHEMA_INVALID__basis-model-with-citations.json", {
  ...c5Answer,
  basis: "model",
  scope: { ...c5Answer.scope, graph: { kind: "none" } },
  citations: [{ kind: "web", title: "Nexus", url: "https://nexus.pubky.app/" }],
});
write(validDir, "answer__basis-knowledge-kind-none-valid.json", {
  ...c5Answer,
  basis: "knowledge",
  scope: { ...c5Answer.scope, graph: { kind: "none" } },
});
write(validDir, "answer__basis-web-kind-none-valid.json", {
  ...c5Answer,
  basis: "web",
  scope: { ...c5Answer.scope, graph: { kind: "none" } },
  citations: [{ kind: "web", title: "News", url: "https://example.com/news" }],
});
write(invalidDir, "answer__SCHEMA_INVALID__basis-web-graph-kind-owner.json", {
  ...c5Answer,
  basis: "web",
  scope: { ...c5Answer.scope, graph: { kind: "owner_network" } },
});
write(invalidDir, "answer__SCHEMA_INVALID__scope-filter-161.json", {
  ...c5Answer,
  scope: { ...c5Answer.scope, filters: ["x".repeat(161)] },
});
write(validDir, "ask-body__c5-valid-post.json", { question: "Suggest tags for this post", target: { kind: "post", uri: `pubky://${TEST_OWNER}/pub/pubky.app/posts/0035NV17R994G` } });
write(validDir, "ask-body__c5-valid-user.json", { question: "Suggest tags for this user", target: { kind: "user", uri: c5Target } });
write(invalidDir, "ask-body__SCHEMA_INVALID__kind-path.json", { question: "Suggest tags for this post", target: { kind: "user", uri: `pubky://${TEST_OWNER}/pub/pubky.app/posts/0035NV17R994G` } });
write(invalidDir, "ask-body__SCHEMA_INVALID__uri-query.json", { question: "Suggest tags for this user", target: { kind: "user", uri: `${c5Target}?x=1` } });

const c6Profile = `pubky://${TEST_OWNER}/pub/pubky.app/profile.json`;
const c6Parent = `pubky://${TEST_OWNER}/pub/pubky.app/posts/0032W6CBGDBP0`;
const c6Answer = {
  schema: "pubchi-answer",
  version: 1,
  bot: TEST_BOT,
  owner: TEST_OWNER,
  generated_at: TEST_NOW,
  run_id: "c6-fixture",
  purpose: "ask",
  question: "Draft a short post about Pubky",
  summary: "A short post you can publish as yourself.",
  evidence: [{ kind: "user", label: "Owner profile", uri: c6Profile, claimants: [], claimant_count: 0, in_your_graph: true }],
  sources: [],
  tool_trace_summary: { tools: [], call_count: 0, truncated: false },
  policy_version: 1,
  section: "draft_post",
  draft_post: {
    content: "Pubky keeps public social state on your homeserver.",
    kind: "short",
    tags: ["pubky-app"],
    rationale: "Matches the public profile evidence.",
    evidence: [c6Profile],
  },
};
write(validDir, "answer__c6-valid.json", c6Answer);
write(validDir, "answer__c6-html-text-valid.json", {
  ...c6Answer,
  run_id: "c6-html-text",
  question: "Draft a short post about markup",
  summary: "HTML in the draft is stored as text.",
  draft_post: { ...c6Answer.draft_post, content: "<script>alert(1)</script> and javascript:alert(1)", rationale: "Markup is stored as text." },
});
write(validDir, "answer__c6-long-parent-valid.json", {
  ...c6Answer,
  run_id: "c6-long",
  question: "Reply with a longer draft",
  summary: "A long reply you can publish as yourself.",
  evidence: [{ kind: "post", label: "Parent post", uri: c6Parent, claimants: [], claimant_count: 0, in_your_graph: true }],
  draft_post: {
    content: "This longer draft replies to the parent post with the same public evidence.",
    kind: "long",
    parent_uri: c6Parent,
    rationale: "Reply uses the parent as evidence.",
    evidence: [c6Parent],
  },
});
write(invalidDir, "answer__SCHEMA_INVALID__c5-and-c6.json", {
  ...c5SuggestionAnswer,
  question: "Suggest a tag and a draft",
  summary: "Both sections at once.",
  draft_post: {
    content: "A draft that must not ride with C5.",
    kind: "short",
    rationale: "Must be exclusive.",
    evidence: [c5Target],
  },
});
write(invalidDir, "answer__SCHEMA_INVALID__c6-missing-section.json", { ...c6Answer, section: undefined });
write(invalidDir, "answer__SCHEMA_INVALID__c6-duplicate-tags.json", {
  ...c6Answer,
  draft_post: { ...c6Answer.draft_post, tags: ["pubky-app", "pubky-app"] },
});
write(invalidDir, "answer__SCHEMA_INVALID__c6-evidence-not-top-level.json", {
  ...c6Answer,
  draft_post: { ...c6Answer.draft_post, evidence: [c6Parent] },
});
write(invalidDir, "answer__SCHEMA_INVALID__c6-whitespace-content.json", {
  ...c6Answer,
  draft_post: { ...c6Answer.draft_post, content: "   \n\t  " },
});
write(invalidDir, "answer__SCHEMA_INVALID__c6-short-too-long.json", {
  ...c6Answer,
  draft_post: { ...c6Answer.draft_post, content: "x".repeat(2001) },
});
write(invalidDir, "answer__UNKNOWN_FIELD__c6-attachments.json", {
  ...c6Answer,
  draft_post: { ...c6Answer.draft_post, attachments: [`pubky://${TEST_OWNER}/pub/pubky.app/files/x`] },
});

void TEST_BOT_SEED;
console.log("fixtures written");
