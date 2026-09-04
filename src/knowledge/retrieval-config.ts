import type { AliasGroup, ProductCue, QueryExpansionConfig } from "../bot-kit/knowledge/query.js";
import type { PathBoostRule, RetrievalConfig } from "../bot-kit/knowledge/store.js";

/** Pubky corpus aliases used to expand lexical tsquery (OR), not AND. */
export const JEB_ALIAS_GROUPS: AliasGroup[] = [
  { cue: /\bhome\s*servers?\b/i, terms: ["homeserver", "homeservers"] },
  { cue: /\bpkarr\b/i, terms: ["pkarr"] },
  { cue: /\bpkdns\b/i, terms: ["pkdns", "pkarr"] },
  { cue: /\bz-?base-?32\b|\bz32\b/i, terms: ["z32", "zbase32"] },
  { cue: /\bweb of trust\b|\bwot\b/i, terms: ["wot"] },
  { cue: /\bindexer\b/i, terms: ["nexus", "indexer"] },
  { cue: /\bmainline\b/i, terms: ["mainline", "bittorrent", "million"] },
  { cue: /\bcreate(?:s|d)? (?:a )?(?:blocktank )?order\b|\bfunction creates\b/i, terms: ["create_order", "lsp_balance"] },
  { cue: /\buniffi\b|\bbindings\b/i, terms: ["python", "swift", "kotlin"] },
  { cue: /\bunlockgrant|\bappkey\b|\bappcert\b/i, terms: ["appkey", "appcert", "unlockgrant"] },
  { cue: /\bmarketplace streams?\b|\bfork-only\b/i, terms: ["listings", "drops", "marketplace"] },
];

export const JEB_PRODUCT_CUES: ProductCue[] = [
  { cue: /\bnexus scout\b/i, tokens: ["scout"] },
  { cue: /\bpaykit\b/i, tokens: ["paykit"] },
  { cue: /\bbitkit\b|\bblocktank\b/i, tokens: ["bitkit"] },
  { cue: /\batomicity\b/i, tokens: ["atomicity"] },
  { cue: /\bpubky-noise\b|\bnoise protocol\b/i, tokens: ["noise"] },
  { cue: /\bsession ttl\b|\brevocat/i, tokens: ["auth", "session"] },
  { cue: /\bpubkyappfeed\b/i, tokens: ["feed"] },
  { cue: /\bpython\b/i, tokens: ["python", "uniffi"] },
];

/** Matches the pre-move `extraTsquery` historical test (no "used to be"). */
export const JEB_EXPANSION_HISTORICAL_CUE = /\b(used to|originally|history|historical|deprecated|slashtags)\b/i;

/** Matches the pre-move `HISTORICAL_CUES` used by `isHistoricalQuery`. */
export const HISTORICAL_CUES = /\b(used to|originally|history|historical|deprecated|slashtags|used to be)\b/i;

export const JEB_QUERY_EXPANSION: QueryExpansionConfig = {
  aliasGroups: JEB_ALIAS_GROUPS,
  productCues: JEB_PRODUCT_CUES,
  historicalCue: JEB_EXPANSION_HISTORICAL_CUE,
  omitAliasTermPatternWhenHistorical: /homeserver/,
};

export const JEB_PATH_BOOSTS: PathBoostRule[] = [
  { url: /gettingstarted|getting_started/i, queryAll: [/\bhomeserver\b/, /\bdatabase\b/], factor: 1.85 },
  { url: /\/auth\.md/i, queryAll: [/\bsession\b/, /\bttl\b|\brevocat/i], factor: 1.85 },
  { url: /paykit_protocol/i, queryAll: [/\bpaykit protocol\b/], factor: 1.85 },
  {
    url: /bitkit-core\/blob\/[^/]+\/README\.md$/i,
    queryAll: [/\b(blocktank|gift|uniffi|python|bitkit-core|bindings)\b/i],
    factor: 2.2,
  },
  { url: /bitkit-core/i, queryAll: [/create_order|blocktank order|uniffi|python/i], factor: 1.85 },
  { url: /mainlinedht|glossary/i, queryAll: [/\bmainline\b/], factor: 1.75 },
  { url: /pubky-locks/i, queryAll: [/\bunlockgrant|appkey|locks hold/i], factor: 1.8 },
  { url: /pubky-nexus/i, queryAll: [/\bmarketplace|listings|drops\b/i], factor: 1.8 },
  { url: /\/SPEC\.md/i, queryAll: [/\bpubkyappfeed\b/i], factor: 1.95 },
  { url: /pubkyring/i, queryAll: [/\bring\b/, /\bkeys?\b/], factor: 1.7 },
];

export const JEB_RETRIEVAL_CONFIG: RetrievalConfig = {
  queryExpansion: JEB_QUERY_EXPANSION,
  historicalCues: HISTORICAL_CUES,
  pathBoosts: JEB_PATH_BOOSTS,
};
