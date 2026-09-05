import { filterOpenTags, preferExistingTags, MAX_OPEN_TAGS } from "./policy.js";
import { suggestTags, toolsUsedInTrace } from "./suggest.js";

export type ProposeOpenTagsInput = {
  intent: string;
  toolTrace: unknown[];
  products?: string[];
  /** Model-proposed labels (already split). */
  proposed?: string[];
  /** Existing Nexus tags (hot + search hits) to prefer when they mean the same thing. */
  nexusTags?: string[];
  personTokens?: string[];
  incrementSecurityEvent?: (rule: string) => void;
  graphTools?: readonly string[];
};

/**
 * Open-vocabulary tag set: model proposals first, remapped onto Nexus
 * existing tags when they match, then a deterministic fallback from
 * intent/products so a missing model still emits useful labels.
 */
export function proposeOpenTags(input: ProposeOpenTagsInput): string[] {
  const fallback = suggestTags({
    intent: input.intent,
    toolTrace: input.toolTrace,
    products: (input.products ?? []).map((p) => p.toLowerCase()),
    vocab: unique([
      "answer",
      "declined",
      "summary",
      "evidence-map",
      "graph",
      ...(input.products ?? []).map((p) => p.toLowerCase().replace(/[^a-z0-9-]+/g, "-")),
    ]),
    precedence: (input.products ?? []).map((p) => p.toLowerCase()),
    graphTools: input.graphTools,
  });
  const remapped = preferExistingTags([...(input.proposed ?? []), ...fallback], input.nexusTags ?? []);
  return filterOpenTags(remapped, {
    personTokens: input.personTokens,
    incrementSecurityEvent: input.incrementSecurityEvent,
    max: MAX_OPEN_TAGS,
  });
}

function unique(xs: string[]): string[] {
  return [...new Set(xs.filter(Boolean))];
}

export { toolsUsedInTrace };
