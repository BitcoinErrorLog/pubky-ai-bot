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
  { cue: /\breply\b|\bparent post\b/i, terms: ["reply", "parent", "post"] },
  { cue: /\bdatabase backend\b|\bpostgres(?:ql)?\b/i, terms: ["database", "postgresql"] },
  { cue: /\bredundancy\b|\bmirrors?\b/i, terms: ["redundancy", "mirrors", "pkarr"] },
  { cue: /\bsingle primary\b|\bload balancing\b/i, terms: ["primary", "replica", "reads", "writes"] },
  { cue: /\bcreate(?:s|d)? (?:a )?(?:blocktank )?order\b|\bfunction creates\b/i, terms: ["create_order", "lsp_balance"] },
  { cue: /\buniffi\b|\bbindings\b/i, terms: ["python", "swift", "kotlin"] },
  { cue: /\bmarketplace streams?\b|\bfork-only\b/i, terms: ["listings", "drops", "marketplace"] },
];

export const JEB_PRODUCT_CUES: ProductCue[] = [
  { cue: /\bnexus scout\b/i, tokens: ["scout"] },
  { cue: /\bpaykit\b/i, tokens: ["paykit"] },
  { cue: /\bslashtags?\b/i, tokens: ["slashtags"] },
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
  {
    url: /bitkit-core\/blob\/[^/]+\/README\.md$/i,
    queryAll: [/\b(blocktank|gift|uniffi|python|bitkit-core|bindings)\b/i],
    factor: 2.2,
  },
  { url: /bitkit-core/i, queryAll: [/create_order|blocktank order|uniffi|python/i], factor: 1.85 },
  { url: /mainlinedht|glossary/i, queryAll: [/\bmainline\b/], factor: 1.75 },
  { url: /pkarr.*README|\/pkarr\/|pkarr\/blob/i, queryAll: [/\bpkarr\b/i], factor: 2.2 },
  { url: /pubky-app-specs|\/SPEC\.md/i, queryAll: [/\bprofile\b|\breply\b|\btags?\b|\bspecs?\b/i], factor: 2.2 },
  { url: /pubky\.org\/FAQ\.md/i, queryAll: [/\bslashtags?\b|\bhypercore\b|\bhistorical\b/i], factor: 2.4 },
  { url: /slashtags/i, queryAll: [/\bslashtags?\b/i], factor: 2.4 },
  { url: /pubky\.org\/GettingStarted\.md/i, queryAll: [/\bhomeserver\b|\bdatabase\b|\bconfig(?:uration)?\b|\bpostgres(?:ql)?\b/i], factor: 2.0 },
  { url: /pubky-core.*AUTH\.md|\/AUTH\.md/i, queryAll: [/\bsession\b|\bcookie\b|\byear\b|\bttl\b/i], factor: 2.5 },
  { url: /pubky-nexus.*README|pubky-nexus/i, queryAll: [/\bnexus\b|\bingest\b|\bevent\b|\bsearch\b/i], factor: 2.0 },
  { url: /Notifications\.md/i, queryAll: [/\bnotification\b/i], factor: 2.5 },
  { url: /pubky\.org\/Architecture\.md/i, queryAll: [/\bapplication[- ]layer\b|\bcomponents?\b/i], factor: 2.3 },
  { url: /pubky-nexus/i, queryAll: [/\bmarketplace|listings|drops\b/i], factor: 1.8 },
  { url: /\/SPEC\.md/i, queryAll: [/\bpubkyappfeed\b/i], factor: 1.95 },
  { url: /pubkyring/i, queryAll: [/\bring\b/, /\bkeys?\b/], factor: 1.7 },
];

export const JEB_RETRIEVAL_CONFIG: RetrievalConfig = {
  queryExpansion: JEB_QUERY_EXPANSION,
  historicalCues: HISTORICAL_CUES,
  pathBoosts: JEB_PATH_BOOSTS,
};
