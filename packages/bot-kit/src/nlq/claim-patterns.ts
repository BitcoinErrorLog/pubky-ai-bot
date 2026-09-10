const GRAPH_NOUNS = "(?:users?|followers?|following|posts?|tags?|taggers?|replies?|mentions?|feeds?|bookmarks?|accounts?|profiles?)";

const UNSUPPORTED_COUNT = new RegExp(
  `(?:\\b\\d[\\d,]*\\s+${GRAPH_NOUNS}\\b|\\b(?:has|have|contains?)\\s+\\d[\\d,]*\\s+${GRAPH_NOUNS}\\b)`,
  "i",
);
const UNSUPPORTED_ACTIVITY = /\bI\s+(?:checked|searched|verified|looked\s+at|queried)\b/i;
const UNSUPPORTED_RECENCY = /\b(?:most\s+recent|latest|newest|recently)\s+(?:posts?|replies?|mentions?|tags?|activity|users?|followers?|following)\b/i;

/** Reject graph-looking assertions when no graph evidence was executed. */
export function hasUnsupportedGraphClaim(text: string): boolean {
  return UNSUPPORTED_COUNT.test(text) || UNSUPPORTED_ACTIVITY.test(text) || UNSUPPORTED_RECENCY.test(text);
}
