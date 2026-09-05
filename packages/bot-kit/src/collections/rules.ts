export type CollectionMatch = {
  series?: string;
  self_tag?: string;
};

export type CollectionRule = {
  collection_key: string;
  title: string;
  description: string;
  match: CollectionMatch;
};

/**
 * Jeb-owned collections. `jeb-blog` has an empty match: every Article/long
 * post is a member. Every other rule matches a published post by `series`
 * and/or `self_tag` alone — weekly series only need to set those tags.
 */
export const JEB_COLLECTION_RULES: readonly CollectionRule[] = [
  {
    collection_key: "jeb-blog",
    title: "Jeb's Blog",
    description: "Every article Jeb publishes, in publish order.",
    match: {},
  },
  {
    collection_key: "pubky-weekly",
    title: "Pubky Weekly",
    description: "The weekly Pubky briefing.",
    match: { self_tag: "pubky-weekly", series: "pubky-weekly" },
  },
  {
    collection_key: "community-feedback",
    title: "Community Feedback",
    description: "What the community asked for and how it was answered.",
    match: { self_tag: "community-feedback", series: "community-feedback" },
  },
  {
    collection_key: "pubky-explained",
    title: "Pubky Explained",
    description: "Mechanism notes from the public knowledge index.",
    match: { self_tag: "pubky-explained", series: "pubky-explained" },
  },
  {
    collection_key: "release-radar",
    title: "Release Radar",
    description: "Dated GitHub releases among indexed sources.",
    match: { self_tag: "release-radar", series: "release-radar" },
  },
  {
    collection_key: "pubky-app",
    title: "Pubky App",
    description: "Posts about Pubky App.",
    match: { self_tag: "pubky-app" },
  },
  {
    collection_key: "pubky-ring",
    title: "Pubky Ring",
    description: "Posts about Pubky Ring.",
    match: { self_tag: "pubky-ring" },
  },
  {
    collection_key: "pubky-core",
    title: "Pubky Core",
    description: "Posts about Pubky Core and the homeserver.",
    match: { self_tag: "pubky-core" },
  },
  {
    collection_key: "pkarr",
    title: "Pkarr",
    description: "Posts about Pkarr.",
    match: { self_tag: "pkarr" },
  },
  {
    collection_key: "nexus",
    title: "Nexus",
    description: "Posts about Nexus.",
    match: { self_tag: "nexus" },
  },
  {
    collection_key: "nexus-scout",
    title: "Nexus Scout",
    description: "Posts about Nexus Scout.",
    match: { self_tag: "nexus-scout" },
  },
  {
    collection_key: "homegate",
    title: "Homegate",
    description: "Posts about Homegate.",
    match: { self_tag: "homegate" },
  },
  {
    collection_key: "paykit",
    title: "Paykit",
    description: "Posts about Paykit.",
    match: { self_tag: "paykit" },
  },
  {
    collection_key: "locks",
    title: "Locks",
    description: "Posts about Locks.",
    match: { self_tag: "locks" },
  },
  {
    collection_key: "loopky",
    title: "Loopky",
    description: "Posts about Loopky.",
    match: { self_tag: "loopky" },
  },
  {
    collection_key: "hypercolor",
    title: "Hypercolor",
    description: "Posts about Hypercolor.",
    match: { self_tag: "hypercolor" },
  },
  {
    collection_key: "jeb",
    title: "Jeb",
    description: "Posts about Jeb.",
    match: { self_tag: "jeb" },
  },
  {
    collection_key: "pubky-bot-kit",
    title: "Pubky Bot Kit",
    description: "Posts about Pubky Bot Kit.",
    match: { self_tag: "pubky-bot-kit" },
  },
];

export type PublishedPost = {
  uri: string;
  kind: "short" | "long";
  self_tags: readonly string[];
  series?: string | null;
};

/** Empty match = Jeb's Blog: every long/article post. Otherwise series and/or self_tag. */
export function ruleMatchesPost(rule: CollectionRule, post: PublishedPost): boolean {
  const series = rule.match.series;
  const selfTag = rule.match.self_tag;
  if (!series && !selfTag) return post.kind === "long";
  if (series && post.series === series) return true;
  if (selfTag && post.self_tags.includes(selfTag)) return true;
  return false;
}

export function matchingCollectionKeys(post: PublishedPost, rules: readonly CollectionRule[] = JEB_COLLECTION_RULES): string[] {
  return rules.filter((r) => ruleMatchesPost(r, post)).map((r) => r.collection_key);
}

export function ruleByKey(key: string, rules: readonly CollectionRule[] = JEB_COLLECTION_RULES): CollectionRule | undefined {
  return rules.find((r) => r.collection_key === key);
}

export function appendItemIdempotent(items: readonly string[], uri: string): { items: string[]; appended: boolean } {
  if (items.includes(uri)) return { items: [...items], appended: false };
  return { items: [...items, uri], appended: true };
}
