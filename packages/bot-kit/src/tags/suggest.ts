export const MAX_REPLY_TAGS = 3;

const BASE_BY_INTENT: Record<string, string> = {
  decline: "declined",
  summarize: "summary",
  evidence_map: "evidence-map",
};

/**
 * Spec limits (pubky-app-specs validationLimits): label 1–20 chars, no
 * commas, colons, or whitespace.
 */
export function isValidTagLabel(label: string): boolean {
  if (label.length < 1 || label.length > 20) return false;
  return !/[,\s:]/.test(label);
}

/** Tool names actually invoked, recovered from the answer tool trace. */
export function toolsUsedInTrace(toolTrace: unknown[]): string[] {
  const names: string[] = [];
  for (const entry of toolTrace) {
    if (!entry || typeof entry !== "object") continue;
    const calls = (entry as { toolCalls?: unknown }).toolCalls;
    if (!Array.isArray(calls)) continue;
    for (const call of calls) {
      const name = (call as { name?: unknown } | null)?.name;
      if (typeof name === "string") names.push(name);
    }
  }
  return names;
}

export type SuggestTagsInput = {
  intent: string;
  toolTrace: unknown[];
  products?: string[];
  vocab: readonly string[];
  /** Product-label order (replaces a hardcoded PRODUCT_CATEGORIES list). */
  precedence?: readonly string[];
  /** Scout (or other) tool names that justify the `graph` label. Injected; Kit has no catalog. */
  graphTools?: readonly string[];
};

/**
 * Deterministic category derivation. Same rules as Jeb `deriveCategories`:
 * base label from intent, then precedence-ordered product labels, then
 * `graph` when a graph tool was used. Cap MAX_REPLY_TAGS. Every emitted
 * label must be in `vocab`.
 */
export function suggestTags(input: SuggestTagsInput): string[] {
  const vocab = new Set(input.vocab);
  const out: string[] = [];
  const add = (label: string) => {
    if (out.length >= MAX_REPLY_TAGS) return;
    if (!vocab.has(label)) return;
    if (out.includes(label)) return;
    out.push(label);
  };

  add(BASE_BY_INTENT[input.intent] ?? "answer");

  const products = input.products ?? [];
  for (const candidate of input.precedence ?? []) {
    if (products.some((p) => p === candidate || p.toLowerCase().includes(candidate))) {
      add(candidate);
    }
  }

  if (out.length < MAX_REPLY_TAGS && vocab.has("graph") && input.graphTools && input.graphTools.length > 0) {
    const used = toolsUsedInTrace(input.toolTrace);
    const graphSet = new Set(input.graphTools);
    if (used.some((name) => graphSet.has(name))) add("graph");
  }

  return out;
}
