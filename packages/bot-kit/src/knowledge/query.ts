/** Caller-supplied lexical expansion. Kit has no product vocabulary. */

export interface AliasGroup {
  cue: RegExp;
  terms: string[];
}

export interface ProductCue {
  cue: RegExp;
  tokens: string[];
}

export interface QueryExpansionConfig {
  aliasGroups: AliasGroup[];
  productCues: ProductCue[];
  /** When this matches, `omitAliasTermPatternWhenHistorical` may drop groups. */
  historicalCue: RegExp;
  /** Drop alias groups whose joined terms match this while the query is historical. */
  omitAliasTermPatternWhenHistorical?: RegExp;
}

export const GENERIC_HISTORICAL_CUE = /\b(used to|originally|history|historical|deprecated|used to be)\b/i;

export const EMPTY_QUERY_EXPANSION: QueryExpansionConfig = {
  aliasGroups: [],
  productCues: [],
  historicalCue: GENERIC_HISTORICAL_CUE,
};

function tsTerm(word: string): string | null {
  const t = word.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "");
  if (t.length < 2) return null;
  return t;
}

/** Extra `to_tsquery` string (OR of aliases). Empty when the question needs no expansion. */
export function extraTsquery(question: string, expansion: QueryExpansionConfig = EMPTY_QUERY_EXPANSION): string {
  const historical = expansion.historicalCue.test(question);
  const terms = new Set<string>();
  for (const g of expansion.aliasGroups) {
    if (
      historical &&
      expansion.omitAliasTermPatternWhenHistorical &&
      expansion.omitAliasTermPatternWhenHistorical.test(g.terms.join(" "))
    ) {
      continue;
    }
    if (g.cue.test(question)) {
      for (const t of g.terms) {
        const x = tsTerm(t);
        if (x) terms.add(x);
      }
    }
  }
  for (const p of expansion.productCues) {
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
export function embeddingQuery(question: string, expansion: QueryExpansionConfig = EMPTY_QUERY_EXPANSION): string {
  const extra = extraTsquery(question, expansion).replaceAll(" | ", " ");
  return extra ? `${question.trim()} ${extra}` : question.trim();
}
