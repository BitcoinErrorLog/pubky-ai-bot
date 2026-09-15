import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { Nexus } from "../packages/bot-kit/src/nexus/nexus.js";
import { canonicalJson } from "../packages/pubchi-schemas/src/canonical.js";

const productionHost = process.env.C5_NEXUS_URL ?? "https://nexus.pubky.app";
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const now = new Date().toISOString();
const manifest: Array<{ uri: string; kind: "post" | "user"; collected_at: string; snapshot_sha256: string; reviewer_decision: "" }> = [];

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function reservoir<T>(items: readonly T[], count: number, next: () => number): T[] {
  const selected: T[] = [];
  for (const [index, item] of items.entries()) {
    if (index < count) selected.push(item);
    else {
      const replacement = Math.floor(next() * (index + 1));
      if (replacement < count) selected[replacement] = item;
    }
  }
  return selected;
}

function seededOrder<T>(items: readonly T[], seed: number): T[] {
  return [...items].map((item, index) => ({ item, rank: random(seed + index)() })).sort((a, b) => a.rank - b.rank).map(({ item }) => item);
}

function takeStrata<T>(items: readonly T[], predicates: Array<(item: T) => boolean>, count: number, seed: number): T[] {
  const selected: T[] = [];
  for (const predicate of predicates) {
    const match = seededOrder(items.filter(predicate).filter((item) => !selected.includes(item)), seed + selected.length)[0];
    if (!match) throw new Error("public sample does not satisfy required C5 golden stratum");
    selected.push(match);
  }
  for (const item of seededOrder(items, seed)) {
    if (selected.length >= count) break;
    if (!selected.includes(item)) selected.push(item);
  }
  if (selected.length !== count) throw new Error(`required ${count} stratified targets; found ${selected.length}`);
  return selected;
}

const nonEnglish = (value: string) => /[^\u0000-\u007f]/u.test(value);
const isReply = (post: { details: { kind: string }; relationships?: { replied?: string | null } }) =>
  Boolean(post.relationships?.replied) || post.details.kind.toLowerCase() === "reply";

async function collect(host: string) {
  const nexus = new Nexus(host, 10_000);
  const posts = [];
  for (let skip = 0; skip <= 990; skip += 30) {
    const page = await nexus.streamPosts({ limit: 30, skip });
    posts.push(...page);
    if (page.length < 30) break;
  }
  const replies = (await Promise.all(
    posts.slice(0, 100).map(async (post) => nexus.postReplies(post.details.author, post.details.id, 2)),
  )).flatMap((value) => Array.isArray(value) ? value : []);
  posts.push(...replies);
  return { nexus, posts };
}

let collected;
let host = productionHost;
try {
  collected = await collect(host);
} catch (error) {
  if (process.env.C5_NEXUS_URL) throw error;
  host = "https://nexus.staging.pubky.app";
  collected = await collect(host);
  console.warn(`production public Nexus was unreachable; used staging: ${error instanceof Error ? error.message : "unknown error"}`);
}
const { nexus, posts } = collected;
const selectedPosts = takeStrata(posts, [
  (post) => (post.counts?.unique_tags ?? post.tags?.length ?? 0) === 0,
  (post) => { const n = post.counts?.unique_tags ?? post.tags?.length ?? 0; return n > 0 && n <= 2; },
  (post) => (post.counts?.unique_tags ?? post.tags?.length ?? 0) >= 3,
  (post) => post.details.content.length <= 140,
  (post) => post.details.content.length > 140,
  (post) => !isReply(post),
  (post) => isReply(post),
  (post) => isReply(post),
  (post) => isReply(post),
  (post) => isReply(post),
  (post) => isReply(post),
  (post) => nonEnglish(post.details.content),
  (post) => nonEnglish(post.details.content),
  (post) => nonEnglish(post.details.content),
  (post) => nonEnglish(post.details.content),
  (post) => nonEnglish(post.details.content),
], 25, 0xc5_2026);
for (const post of selectedPosts) {
  const uri = post.details.uri;
  manifest.push({ uri, kind: "post", collected_at: now, snapshot_sha256: hash({ kind: "post", uri, author: post.details.author, content: post.details.content, post_kind: post.details.kind }), reviewer_decision: "" });
}
const profiles: Array<{ pubky: string; profile: Awaited<ReturnType<typeof nexus.userDetails>>; tagCount: number }> = [];
for (const pubky of seededOrder([...new Set(posts.map((post) => post.details.author))], 0xc5_2027)) {
  const profile = await nexus.userDetails(pubky);
  if (!profile) continue;
  const tags = await nexus.userTags(pubky);
  profiles.push({ pubky, profile, tagCount: Array.isArray(tags) ? tags.length : 0 });
  if (profiles.length >= 100) break;
}
const selectedProfiles = takeStrata(profiles, [
  (profile) => profile.tagCount <= 1,
  (profile) => profile.tagCount >= 5,
  (profile) => nonEnglish(`${profile.profile?.name ?? ""} ${profile.profile?.bio ?? ""}`),
], 25, 0xc5_2027);
for (const { pubky, profile } of selectedProfiles) {
  const uri = `pubky://${pubky}/pub/pubky.app/profile.json`;
  manifest.push({ uri, kind: "user", collected_at: now, snapshot_sha256: hash({ kind: "user", uri, pubky, name: profile.name, bio: profile.bio ?? null }), reviewer_decision: "" });
}
if (posts.length < 1_000 && manifest.length !== 50) throw new Error(`expected 50 public targets; sampled ${posts.length} posts and collected ${manifest.length}`);
if (manifest.length !== 50) throw new Error(`sampled ${posts.length} posts but collected only ${manifest.length} targets`);
mkdirSync("packages/pubchi/fixtures", { recursive: true });
writeFileSync("packages/pubchi/fixtures/c5-golden-manifest.json", `${JSON.stringify({ nexus_host: host, targets: manifest }, null, 2)}\n`);
const postTagCount = (predicate: (post: typeof selectedPosts[number]) => boolean) => selectedPosts.filter(predicate).length;
const profileTagCount = (predicate: (profile: typeof selectedProfiles[number]) => boolean) => selectedProfiles.filter(predicate).length;
console.log(JSON.stringify({
  collected: manifest.length,
  host,
  sampled_posts: posts.length,
  strata: {
    posts: {
      no_tags: postTagCount((post) => (post.counts?.unique_tags ?? post.tags?.length ?? 0) === 0),
      few_tags: postTagCount((post) => { const n = post.counts?.unique_tags ?? post.tags?.length ?? 0; return n > 0 && n <= 2; }),
      many_tags: postTagCount((post) => (post.counts?.unique_tags ?? post.tags?.length ?? 0) >= 3),
      short: postTagCount((post) => post.details.content.length <= 140),
      long: postTagCount((post) => post.details.content.length > 140),
      root: postTagCount((post) => !isReply(post)),
      reply: postTagCount((post) => isReply(post)),
      non_english: postTagCount((post) => nonEnglish(post.details.content)),
    },
    users: {
      sparse_tags: profileTagCount((profile) => profile.tagCount <= 1),
      dense_tags: profileTagCount((profile) => profile.tagCount >= 5),
      non_english: profileTagCount((profile) => nonEnglish(`${profile.profile?.name ?? ""} ${profile.profile?.bio ?? ""}`)),
    },
  },
} satisfies { collected: number; host: string; sampled_posts: number; strata: Record<string, Record<string, number>> }));
