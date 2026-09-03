import { z } from "zod";
import type pg from "pg";
import type { Config } from "../config.js";
import { parsePostUri, Z32 } from "../types.js";

function parseUserPk(pubky: string): string {
  const id = pubky.trim();
  if (!Z32.test(id)) throw new Error("invalid pubky");
  return id;
}

function clampLimit(n: number, max: number): number {
  if (!Number.isFinite(n)) return Math.min(10, max);
  return Math.min(max, Math.max(1, Math.floor(n)));
}
import { ScoutClient, ScoutToolError } from "./client.js";
import { budgetError, checkScoutBudgets, scoutSwitchBlocked } from "./budget.js";
import { guardRawCypher } from "./guard.js";
import {
  debateMapTemplate,
  emergingWindowTemplate,
  identityFollowersTemplate,
  identityFollowingTemplate,
  identityPostsTemplate,
  identityTagsTemplate,
  RELATED,
  relatedPostsTemplate,
  relationshipFollowsTemplate,
  relationshipSharedTaggersTemplate,
  relationshipTagsTemplate,
  searchPostsTemplate,
  searchUsersByNameTemplate,
  tagLandscapeTemplate,
  tagOverlapTemplate,
  threadDownTemplate,
  threadUpTemplate,
  topicPostsTemplate,
  whatChangedTemplate,
  type RelatedKind,
} from "./templates.js";
import {
  capIds,
  claimSchema,
  defaultTimeRange,
  graphScopeSchema,
  postUri,
  timeRangeSchema,
  type Claim,
  type EvidenceMeta,
} from "./types.js";

function asRows(results: unknown[]): Record<string, unknown>[] {
  return results.map((r) => (r && typeof r === "object" ? (r as Record<string, unknown>) : {}));
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function strArr(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map(str).filter(Boolean);
}

export const searchPostsParams = z.object({
  query: z.string().min(1).max(200),
  time_range: timeRangeSchema,
  authors: z.array(z.string()).max(32).optional(),
  tags: z.array(z.string()).max(16).optional(),
  limit: z.number().int().positive().optional(),
});

export const getThreadParams = z.object({
  uri: z.string(),
  depth: z.number().int().min(1).max(5).optional(),
  include_profiles: z.boolean().optional(),
});

export const identityParams = z.object({
  pubky: z.string(),
  time_range: timeRangeSchema,
});

export const topicParams = z.object({
  topic: z.string().min(1).max(80),
  time_range: timeRangeSchema,
  graph_scope: graphScopeSchema,
});

export const whatChangedParams = z.object({
  topic: z.string().min(1).max(80),
  since: z.number().int().nonnegative(),
});

export const relatedParams = z.object({
  uri: z.string(),
  relationship: z.enum(RELATED),
  limit: z.number().int().positive().optional(),
});

export const relationshipParams = z.object({
  pubky_a: z.string(),
  pubky_b: z.string(),
});

export const tagParams = z.object({
  tag: z.string().min(1).max(20),
  time_range: timeRangeSchema,
});

export const emergingParams = z.object({
  graph_scope: graphScopeSchema,
  time_range: timeRangeSchema,
});

export const debateParams = z.object({
  topic: z.string().min(1).max(80),
  time_range: timeRangeSchema,
});

export const queryGraphParams = z.object({
  cypher: z.string().min(1).max(2000),
  params: z.record(z.unknown()).optional(),
});

export function createScoutTools(opts: {
  cfg: Config;
  pool: pg.Pool;
  mentionKey?: string;
  author?: string;
  storeSwitchOn: () => Promise<boolean>;
  client?: ScoutClient;
}) {
  const client = opts.client ?? new ScoutClient(opts.cfg, opts.pool);
  const cap = opts.cfg.scoutClaimantCap;
  const lim = (n?: number) => clampLimit(n ?? 25, opts.cfg.scoutLimitMax);

  const run = async (tool: string, raw: boolean, fn: () => Promise<unknown>) => {
    if (!opts.cfg.scoutEnabled) {
      return new ScoutToolError("DISABLED", "graph lookup unavailable right now").toPublic();
    }
    if (await scoutSwitchBlocked(opts.storeSwitchOn)) {
      return new ScoutToolError("SWITCH", "graph lookup unavailable right now").toPublic();
    }
    const gate = await checkScoutBudgets(opts.pool, opts.cfg, {
      mentionKey: opts.mentionKey,
      author: opts.author,
      raw,
    });
    if (gate.blocked) return budgetError(gate.reason ?? "budget").toPublic();
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ScoutToolError) return e.toPublic();
      throw e;
    }
  };

  const meta = (tool: string, truncated: boolean, notes: string[] | undefined, scope: EvidenceMeta["scope"]): EvidenceMeta => ({
    provenance: "scout",
    tool,
    truncated,
    notes: notes ?? [],
    scope,
  });

  return {
    search_posts: {
      description:
        "Search Pubky posts by substring plus optional authors, tags, and time. Returns URIs, authors, timestamps, and tag claims — not interpretations.",
      parameters: searchPostsParams,
      execute: (args: z.infer<typeof searchPostsParams>) =>
        run("search_posts", false, async () => {
          const time = defaultTimeRange(args.time_range);
          const authors = (args.authors ?? []).map(parseUserPk);
          const tags = (args.tags ?? []).map((t) => t.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 20)).filter(Boolean);
          const q = searchPostsTemplate({
            query: args.query,
            time,
            authors,
            tags,
            limit: lim(args.limit),
          });
          const { envelope } = await client.query({
            cypher: q.cypher,
            params: q.params,
            limit: q.limit,
            tool: "search_posts",
            mentionKey: opts.mentionKey,
          });
          const posts = asRows(envelope.results).map((r) => {
            const author_id = str(r.author_id);
            const post_id = str(r.post_id);
            const taggers = strArr(r.taggers);
            const labels = strArr(r.labels);
            const claims: Claim[] = labels.map((label) => ({
              label,
              count: taggers.length,
              claimant_ids: capIds(taggers, cap),
            }));
            return {
              uri: postUri(author_id, post_id),
              author_id,
              author_name: str(r.author_name),
              indexed_at: num(r.indexed_at),
              kind: str(r.kind),
              content_preview: str(r.content).slice(0, 280),
              claims,
            };
          });
          return {
            ...meta("search_posts", envelope.truncated, envelope.notes, {
              time_range: time,
              filters: { query: args.query, authors, tags },
            }),
            posts,
            truncated: envelope.truncated,
          };
        }),
    },
    scout_get_thread: {
      description: "REPLIED chain up and down from a post URI. Evidence only: URIs, authors, timestamps, tag claims.",
      parameters: getThreadParams,
      execute: (args: z.infer<typeof getThreadParams>) =>
        run("scout_get_thread", false, async () => {
          const { author, postId } = parsePostUri(args.uri);
          const depth = Math.min(5, Math.max(1, args.depth ?? 3));
          const up = threadUpTemplate(postId, depth, lim(40));
          const down = threadDownTemplate(postId, depth, lim(40));
          const a = await client.query({
            cypher: up.cypher,
            params: up.params,
            limit: up.limit,
            tool: "scout_get_thread",
            mentionKey: opts.mentionKey,
          });
          const b = await client.query({
            cypher: down.cypher,
            params: down.params,
            limit: down.limit,
            tool: "scout_get_thread",
            mentionKey: opts.mentionKey,
          });
          const mapPost = (r: Record<string, unknown>) => {
            const author_id = str(r.author_id);
            const post_id = str(r.post_id);
            const names = args.include_profiles ? { author_name: str(r.author_name) } : {};
            return {
              uri: postUri(author_id, post_id),
              author_id,
              ...names,
              indexed_at: num(r.indexed_at),
              direction: str(r.direction),
              claims: strArr(r.labels).map((label) => ({
                label,
                count: strArr(r.taggers).length,
                claimant_ids: capIds(strArr(r.taggers), cap),
              })),
            };
          };
          const truncated = a.envelope.truncated || b.envelope.truncated;
          return {
            ...meta("scout_get_thread", truncated, [...(a.envelope.notes ?? []), ...(b.envelope.notes ?? [])], {
              time_range: defaultTimeRange(),
              filters: { uri: args.uri, depth, include_profiles: Boolean(args.include_profiles), root_author: author },
            }),
            posts: [...asRows(a.envelope.results).map(mapPost), ...asRows(b.envelope.results).map(mapPost)],
            truncated,
          };
        }),
    },
    get_identity_summary: {
      description:
        "Counts of posts, followers, following, and tags received (grouped by label with distinct taggers and self-tag). Not a character judgment.",
      parameters: identityParams,
      execute: (args: z.infer<typeof identityParams>) =>
        run("get_identity_summary", false, async () => {
          const id = parseUserPk(args.pubky);
          const time = defaultTimeRange(args.time_range);
          const postsQ = identityPostsTemplate(id, time);
          const folQ = identityFollowersTemplate(id);
          const fingQ = identityFollowingTemplate(id);
          const tagsQ = identityTagsTemplate(id, time, lim(20));
          const posts = await client.query({
            cypher: postsQ.cypher,
            params: postsQ.params,
            limit: 1,
            tool: "get_identity_summary",
            mentionKey: opts.mentionKey,
          });
          const fol = await client.query({
            cypher: folQ.cypher,
            params: folQ.params,
            limit: 1,
            tool: "get_identity_summary",
            mentionKey: opts.mentionKey,
          });
          const fing = await client.query({
            cypher: fingQ.cypher,
            params: fingQ.params,
            limit: 1,
            tool: "get_identity_summary",
            mentionKey: opts.mentionKey,
          });
          const tags = await client.query({
            cypher: tagsQ.cypher,
            params: tagsQ.params,
            limit: tagsQ.limit,
            tool: "get_identity_summary",
            mentionKey: opts.mentionKey,
          });
          const p0 = asRows(posts.envelope.results)[0] ?? {};
          const claims = asRows(tags.envelope.results).map((r) => ({
            label: str(r.label),
            count: num(r.count),
            claimant_ids: capIds(strArr(r.claimant_ids), cap),
            self_claim: Boolean(r.self_claim),
          }));
          const truncated =
            posts.envelope.truncated || fol.envelope.truncated || fing.envelope.truncated || tags.envelope.truncated;
          return {
            ...meta("get_identity_summary", truncated, tags.envelope.notes, {
              time_range: time,
              filters: { pubky: id },
            }),
            pubky: id,
            name: str(p0.name),
            posts: num(p0.posts),
            followers: num(asRows(fol.envelope.results)[0]?.followers),
            following: num(asRows(fing.envelope.results)[0]?.following),
            tag_claims: claims,
            truncated,
          };
        }),
    },
    get_topic_brief: {
      description: "Posts matching a tag label or content substring, top authors, distinct participants. Evidence fields only.",
      parameters: topicParams,
      execute: (args: z.infer<typeof topicParams>) =>
        run("get_topic_brief", false, async () => {
          const time = defaultTimeRange(args.time_range);
          const scopeId = args.graph_scope?.pubky ? parseUserPk(args.graph_scope.pubky) : "";
          const hops = args.graph_scope?.hops ?? 1;
          const q = topicPostsTemplate({ topic: args.topic, time, scopeId, hops, limit: lim(25) });
          const { envelope } = await client.query({
            cypher: q.cypher,
            params: q.params,
            limit: q.limit,
            tool: "get_topic_brief",
            mentionKey: opts.mentionKey,
          });
          const posts = asRows(envelope.results).map((r) => {
            const author_id = str(r.author_id);
            return {
              uri: postUri(author_id, str(r.post_id)),
              author_id,
              indexed_at: num(r.indexed_at),
              claims: strArr(r.labels).map((label) => ({
                label,
                count: strArr(r.taggers).length,
                claimant_ids: capIds(strArr(r.taggers), cap),
              })),
            };
          });
          const authors = new Map<string, number>();
          for (const p of posts) authors.set(p.author_id, (authors.get(p.author_id) ?? 0) + 1);
          const top_authors = [...authors.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([author_id, post_count]) => ({ author_id, post_count }));
          return {
            ...meta("get_topic_brief", envelope.truncated, envelope.notes, {
              time_range: time,
              graph_scope: args.graph_scope,
              filters: { topic: args.topic },
            }),
            posts,
            top_authors,
            distinct_participants: authors.size,
            truncated: envelope.truncated,
          };
        }),
    },
    get_what_changed: {
      description: "Posts and tag claims on a topic since a timestamp. Evidence only.",
      parameters: whatChangedParams,
      execute: (args: z.infer<typeof whatChangedParams>) =>
        run("get_what_changed", false, async () => {
          const until = Date.now();
          const q = whatChangedTemplate(args.topic, args.since, until, lim(25));
          const { envelope } = await client.query({
            cypher: q.cypher,
            params: q.params,
            limit: q.limit,
            tool: "get_what_changed",
            mentionKey: opts.mentionKey,
          });
          const posts = asRows(envelope.results).map((r) => {
            const author_id = str(r.author_id);
            const rawClaims = Array.isArray(r.claims) ? r.claims : [];
            const grouped = new Map<string, string[]>();
            for (const c of rawClaims) {
              if (!c || typeof c !== "object") continue;
              const row = c as { label?: unknown; tagger?: unknown };
              const label = str(row.label);
              if (!label) continue;
              const list = grouped.get(label) ?? [];
              list.push(str(row.tagger));
              grouped.set(label, list);
            }
            return {
              uri: postUri(author_id, str(r.post_id)),
              author_id,
              indexed_at: num(r.indexed_at),
              claims: [...grouped.entries()].map(([label, ids]) => ({
                label,
                count: ids.filter(Boolean).length,
                claimant_ids: capIds(ids, cap),
              })),
            };
          });
          return {
            ...meta("get_what_changed", envelope.truncated, envelope.notes, {
              time_range: { since: args.since, until },
              filters: { topic: args.topic },
            }),
            posts,
            truncated: envelope.truncated,
          };
        }),
    },
    get_related_posts: {
      description: "Posts related by replied, reposted, mentioned, tagged, or same_author.",
      parameters: relatedParams,
      execute: (args: z.infer<typeof relatedParams>) =>
        run("get_related_posts", false, async () => {
          const { author, postId } = parsePostUri(args.uri);
          const kind = args.relationship as RelatedKind;
          const q = relatedPostsTemplate(author, postId, kind, lim(args.limit));
          const { envelope } = await client.query({
            cypher: q.cypher,
            params: q.params,
            limit: q.limit,
            tool: "get_related_posts",
            mentionKey: opts.mentionKey,
          });
          const posts = asRows(envelope.results).map((r) => ({
            uri: postUri(str(r.author_id), str(r.post_id)),
            author_id: str(r.author_id),
            indexed_at: num(r.indexed_at),
            relationship: str(r.relationship),
            claims: [] as Claim[],
          }));
          return {
            ...meta("get_related_posts", envelope.truncated, envelope.notes, {
              time_range: defaultTimeRange(),
              filters: { uri: args.uri, relationship: kind },
            }),
            posts,
            truncated: envelope.truncated,
          };
        }),
    },
    get_relationship: {
      description: "Follows both ways, mutual user-tags with labels, shared tagger count. Evidence, not a relationship verdict.",
      parameters: relationshipParams,
      execute: (args: z.infer<typeof relationshipParams>) =>
        run("get_relationship", false, async () => {
          const a = parseUserPk(args.pubky_a);
          const b = parseUserPk(args.pubky_b);
          const fQ = relationshipFollowsTemplate(a, b);
          const tQ = relationshipTagsTemplate(a, b, lim(30));
          const sQ = relationshipSharedTaggersTemplate(a, b);
          const f = await client.query({
            cypher: fQ.cypher,
            params: fQ.params,
            limit: 1,
            tool: "get_relationship",
            mentionKey: opts.mentionKey,
          });
          const t = await client.query({
            cypher: tQ.cypher,
            params: tQ.params,
            limit: tQ.limit,
            tool: "get_relationship",
            mentionKey: opts.mentionKey,
          });
          const s = await client.query({
            cypher: sQ.cypher,
            params: sQ.params,
            limit: 1,
            tool: "get_relationship",
            mentionKey: opts.mentionKey,
          });
          const fr = asRows(f.envelope.results)[0] ?? {};
          const claims = asRows(t.envelope.results).map((r) => ({
            label: str(r.label),
            count: 1,
            claimant_ids: capIds([str(r.tagger_id)], cap),
            target_id: str(r.target_id),
            indexed_at: num(r.indexed_at),
          }));
          const truncated = f.envelope.truncated || t.envelope.truncated || s.envelope.truncated;
          return {
            ...meta("get_relationship", truncated, t.envelope.notes, {
              time_range: defaultTimeRange(),
              filters: { pubky_a: a, pubky_b: b },
            }),
            a_follows_b: Boolean(fr.a_follows_b),
            b_follows_a: Boolean(fr.b_follows_a),
            tag_claims: claims,
            shared_taggers: num(asRows(s.envelope.results)[0]?.shared_taggers),
            truncated,
          };
        }),
    },
    get_tag_landscape: {
      description: "Who applies a tag, to whom, self vs third-party, tagger-overlap cluster hint. Claims only.",
      parameters: tagParams,
      execute: (args: z.infer<typeof tagParams>) =>
        run("get_tag_landscape", false, async () => {
          const time = defaultTimeRange(args.time_range);
          const tag = args.tag.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 20);
          if (!tag) throw new ScoutToolError("BAD_INPUT", "invalid tag");
          const land = tagLandscapeTemplate(tag, time, lim(50));
          const ov = tagOverlapTemplate(tag, time, lim(15));
          const l = await client.query({
            cypher: land.cypher,
            params: land.params,
            limit: land.limit,
            tool: "get_tag_landscape",
            mentionKey: opts.mentionKey,
          });
          const o = await client.query({
            cypher: ov.cypher,
            params: ov.params,
            limit: ov.limit,
            tool: "get_tag_landscape",
            mentionKey: opts.mentionKey,
          });
          const applications = asRows(l.envelope.results).map((r) => ({
            tagger_id: str(r.tagger_id),
            target_id: str(r.target_id),
            target_kind: str(r.target_kind),
            self_claim: Boolean(r.self_claim),
            indexed_at: num(r.indexed_at),
            uri:
              str(r.target_kind) === "Post"
                ? str(r.owner_id)
                  ? postUri(str(r.owner_id), str(r.target_id))
                  : `pubky://unknown/pub/pubky.app/posts/${str(r.target_id)}`
                : `pubky://${str(r.target_id)}/`,
          }));
          const claims: Claim[] = [
            {
              label: tag,
              count: applications.length,
              claimant_ids: capIds(
                applications.map((x) => x.tagger_id),
                cap,
              ),
            },
          ];
          const truncated = l.envelope.truncated || o.envelope.truncated;
          return {
            ...meta("get_tag_landscape", truncated, l.envelope.notes, {
              time_range: time,
              filters: { tag },
            }),
            applications,
            self_claim_count: applications.filter((x) => x.self_claim).length,
            third_party_count: applications.filter((x) => !x.self_claim).length,
            cluster_hint: asRows(o.envelope.results).map((r) => ({
              tagger_a: str(r.a),
              tagger_b: str(r.b),
              shared_targets: num(r.shared_targets),
            })),
            claims,
            truncated,
          };
        }),
    },
    get_emerging_topics: {
      description: "Tag labels whose distinct-tagger counts rose in the window versus the prior window of equal length.",
      parameters: emergingParams,
      execute: (args: z.infer<typeof emergingParams>) =>
        run("get_emerging_topics", false, async () => {
          const time = defaultTimeRange(args.time_range);
          const span = Math.max(1, time.until - time.since);
          const prior = { since: time.since - span, until: time.since - 1 };
          const scopeId = args.graph_scope?.pubky ? parseUserPk(args.graph_scope.pubky) : "";
          const hops = args.graph_scope?.hops ?? 1;
          const curQ = emergingWindowTemplate(time.since, time.until, scopeId, hops, lim(25));
          const prevQ = emergingWindowTemplate(prior.since, prior.until, scopeId, hops, lim(25));
          const cur = await client.query({
            cypher: curQ.cypher,
            params: curQ.params,
            limit: curQ.limit,
            tool: "get_emerging_topics",
            mentionKey: opts.mentionKey,
          });
          const prev = await client.query({
            cypher: prevQ.cypher,
            params: prevQ.params,
            limit: prevQ.limit,
            tool: "get_emerging_topics",
            mentionKey: opts.mentionKey,
          });
          const prevMap = new Map<string, number>();
          for (const r of asRows(prev.envelope.results)) prevMap.set(str(r.label), num(r.distinct_taggers));
          const topics = asRows(cur.envelope.results)
            .map((r) => {
              const label = str(r.label);
              const now = num(r.distinct_taggers);
              const before = prevMap.get(label) ?? 0;
              return {
                label,
                distinct_taggers: now,
                prior_distinct_taggers: before,
                delta: now - before,
                uses: num(r.uses),
              };
            })
            .filter((t) => t.delta > 0)
            .sort((a, b) => b.delta - a.delta);
          const truncated = cur.envelope.truncated || prev.envelope.truncated;
          return {
            ...meta("get_emerging_topics", truncated, cur.envelope.notes, {
              time_range: time,
              graph_scope: args.graph_scope,
              filters: { prior_window: prior },
            }),
            topics,
            truncated,
          };
        }),
    },
    get_debate_map: {
      description:
        "Reply chains on a topic where participants tagged each other with differing labels. Sides are author clusters with evidence posts — not a winner.",
      parameters: debateParams,
      execute: (args: z.infer<typeof debateParams>) =>
        run("get_debate_map", false, async () => {
          const time = defaultTimeRange(args.time_range);
          const q = debateMapTemplate(args.topic, time, lim(30));
          const { envelope } = await client.query({
            cypher: q.cypher,
            params: q.params,
            limit: q.limit,
            tool: "get_debate_map",
            mentionKey: opts.mentionKey,
          });
          const sides = new Map<string, { authors: Set<string>; posts: Set<string>; claims: Claim[] }>();
          for (const r of asRows(envelope.results)) {
            const la = str(r.label_a_on_b);
            const lb = str(r.label_b_on_a);
            const root = postUri(str(r.root_author), str(r.root_post_id));
            const reply = postUri(str(r.author_b), str(r.reply_id));
            for (const [label, author, other] of [
              [la, str(r.author_a), str(r.author_b)],
              [lb, str(r.author_b), str(r.author_a)],
            ] as const) {
              const bucket = sides.get(label) ?? { authors: new Set<string>(), posts: new Set<string>(), claims: [] };
              bucket.authors.add(author);
              bucket.posts.add(root);
              bucket.posts.add(reply);
              bucket.claims.push({
                label,
                count: 1,
                claimant_ids: capIds([author], cap),
                target_id: other,
              });
              sides.set(label, bucket);
            }
          }
          const clusters = [...sides.entries()].map(([label, b]) => ({
            label,
            author_ids: [...b.authors],
            evidence_uris: [...b.posts],
            claim_count: b.claims.length,
            claimant_ids: capIds(
              b.claims.flatMap((c) => c.claimant_ids),
              cap,
            ),
          }));
          return {
            ...meta("get_debate_map", envelope.truncated, envelope.notes, {
              time_range: time,
              filters: { topic: args.topic },
            }),
            clusters,
            truncated: envelope.truncated,
          };
        }),
    },
    query_graph: {
      description: "Guarded raw Cypher escape hatch. Disabled unless JEB_SCOUT_RAW_ENABLED=1. Evidence rows only.",
      parameters: queryGraphParams,
      execute: (args: z.infer<typeof queryGraphParams>) =>
        run("query_graph", true, async () => {
          const g = guardRawCypher(args.cypher, args.params ?? {}, {
            limitMax: opts.cfg.scoutLimitMax,
            profilePropMax: opts.cfg.scoutProfilePropMax,
            rawEnabled: opts.cfg.scoutRawEnabled,
          });
          if (!g.ok || !g.cypher) {
            throw new ScoutToolError("QUERY_REJECTED", g.reason ?? "rejected");
          }
          const { envelope } = await client.query({
            cypher: g.cypher,
            params: args.params ?? {},
            limit: g.limit,
            tool: "query_graph",
            mentionKey: opts.mentionKey,
          });
          return {
            ...meta("query_graph", envelope.truncated, envelope.notes, {
              time_range: defaultTimeRange(),
              filters: { raw: true },
            }),
            results: envelope.results,
            count: envelope.count,
            truncated: envelope.truncated,
          };
        }),
    },
    search_users_by_name: {
      description: "Resolve display names to pubky ids (names are not unique). Use before identity tools.",
      parameters: z.object({ name: z.string().min(1).max(80), limit: z.number().int().positive().optional() }),
      execute: (args: { name: string; limit?: number }) =>
        run("search_users_by_name", false, async () => {
          const q = searchUsersByNameTemplate(args.name, lim(args.limit ?? 10));
          const { envelope } = await client.query({
            cypher: q.cypher,
            params: q.params,
            limit: q.limit,
            tool: "search_users_by_name",
            mentionKey: opts.mentionKey,
          });
          return {
            ...meta("search_users_by_name", envelope.truncated, envelope.notes, {
              time_range: defaultTimeRange(),
              filters: { name: args.name },
            }),
            users: asRows(envelope.results).map((r) => ({
              pubky: str(r.id),
              name: str(r.name),
              bio: str(r.bio),
              followers: num(r.followers),
            })),
            truncated: envelope.truncated,
          };
        }),
    },
  };
}

export { claimSchema };
