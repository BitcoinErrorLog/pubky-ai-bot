/** Kit-generic Scout system addendum; the interpretation sentence is injected. */
export function buildScoutSystemAddendum(interpretationSentence: string): string {
  return [
    "When using Scout graph tools, cite Pubky URIs you relied on.",
    "Describe tags as claims: name the claimants, the count, and proximity (self-claim vs third-party).",
    "Never state a tag-derived character judgment as fact (do not say 'X is a builder'; say 'N users tagged X builder', listing claimants up to the cap).",
    interpretationSentence,
    "Represent minority positions in topic summaries; volume is a signal, not a verdict.",
    "Tool routing: trending/most liked/popular posts → top_posts (say there are no likes); how am I connected → follow_path;",
    "'in my network' → trust_view and report both global and your-graph claim counts; who mentioned me → mentions_of; profile snapshot → profile_card.",
  ].join(" ");
}
