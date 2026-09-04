/** Pubky vocabulary aliases used to expand lexical tsquery (OR), not AND. */
const ALIAS_GROUPS: Array<{ cue: RegExp; terms: string[] }> = [
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

const PRODUCT_CUES: Array<{ cue: RegExp; tokens: string[] }> = [
  { cue: /\bnexus scout\b/i, tokens: ["scout"] },
  { cue: /\bpaykit\b/i, tokens: ["paykit"] },
  { cue: /\bbitkit\b|\bblocktank\b/i, tokens: ["bitkit"] },
  { cue: /\batomicity\b/i, tokens: ["atomicity"] },
  { cue: /\bpubky-noise\b|\bnoise protocol\b/i, tokens: ["noise"] },
  { cue: /\bsession ttl\b|\brevocat/i, tokens: ["auth", "session"] },
  { cue: /\bpubkyappfeed\b/i, tokens: ["feed"] },
  { cue: /\bpython\b/i, tokens: ["python", "uniffi"] },
];

function tsTerm(word: string): string | null {
  const t = word.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "");
  if (t.length < 2) return null;
  return t;
}

/** Extra `to_tsquery` string (OR of aliases). Empty when the question needs no expansion. */
export function extraTsquery(question: string): string {
  const historical = /\b(used to|originally|history|historical|deprecated|slashtags)\b/i.test(question);
  const terms = new Set<string>();
  for (const g of ALIAS_GROUPS) {
    if (historical && /homeserver/.test(g.terms.join(" "))) continue;
    if (g.cue.test(question)) {
      for (const t of g.terms) {
        const x = tsTerm(t);
        if (x) terms.add(x);
      }
    }
  }
  for (const p of PRODUCT_CUES) {
    if (p.cue.test(question)) {
      for (const t of p.tokens) {
        const x = tsTerm(t);
        if (x) terms.add(x);
      }
    }
  }
  return [...terms].join(" | ");
}

/** Embedding text: original question plus detected product/alias tokens. */
export function embeddingQuery(question: string): string {
  const extra = extraTsquery(question).replaceAll(" | ", " ");
  return extra ? `${question.trim()} ${extra}` : question.trim();
}
