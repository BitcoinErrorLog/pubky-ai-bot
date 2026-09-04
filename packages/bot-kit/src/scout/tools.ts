import { z } from "zod";
import type pg from "pg";
import { log } from "../log.js";
import type { ScoutEnvSwitchOn, ScoutToolsConfig } from "./scout-config.js";
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
import { getActiveScoutSchema } from "./schema-cache.js";
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
  rankUsersTemplate,
  RANK_USER_METRICS,
  recommendFollowsTemplate,
  staleFollowsTemplate,
  userTagLabelsTemplate,
  FOLLOW_TOOL_LIMIT,
  FOLLOW_PATH_MAX_HOPS,
  TRUST_VIEW_MAX_HOPS,
  TOP_POST_METRICS,
  followPathCountTemplate,
  followPathTemplate,
  trustViewUserTemplate,
  trustViewTopicTemplate,
  topPostsTemplate,
  mentionsOfTemplate,
  profileSnapshotTemplate,
  profileTagsAppliedTemplate,
  profileRepliedToTemplate,
  profileMutualTemplate,
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

export const rankUsersParams = z.object({
  metric: z.enum(RANK_USER_METRICS),
  order: z.enum(["asc", "desc"]).optional(),
  time_range: timeRangeSchema,
  limit: z.number().int().positive().optional(),
});

export const recommendFollowsParams = z.object({
  pubky: z.string(),
  limit: z.number().int().positive().max(FOLLOW_TOOL_LIMIT).optional(),
});

export const staleFollowsParams = z.object({
  pubky: z.string(),
  inactive_days: z.number().int().positive().max(3650).optional(),
  limit: z.number().int().positive().max(FOLLOW_TOOL_LIMIT).optional(),
});

export const followPathParams = z.object({
  a: z.string(),
  b: z.string(),
  max_hops: z.number().int().min(1).max(FOLLOW_PATH_MAX_HOPS).optional(),
  limit: z.number().int().positive().max(FOLLOW_TOOL_LIMIT).optional(),
});

export const trustViewParams = z
  .object({
    asker: z.string().regex(Z32),
    target: z.string().optional(),
    topic: z.string().min(1).max(80).optional(),
    hops: z.number().int().min(1).max(TRUST_VIEW_MAX_HOPS).optional(),
    time_range: timeRangeSchema,
    limit: z.number().int().positive().optional(),
  })
  .superRefine((val, ctx) => {
    const hasTarget = Boolean(val.target?.trim());
    const hasTopic = Boolean(val.topic?.trim());
    if (hasTarget === hasTopic) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "provide exactly one of target or topic",
      });
    }
  });

export const topPostsParams = z.object({
  metric: z.enum(TOP_POST_METRICS),
  time_range: timeRangeSchema,
  topic: z.string().min(1).max(80).optional(),
  limit: z.number().int().positive().optional(),
});

export const mentionsOfParams = z.object({
  pubky: z.string(),
  time_range: timeRangeSchema,
  limit: z.number().int().positive().optional(),
});

export const profileCardParams = z.object({
  pubky: z.string(),
  asker: z.string().regex(Z32).optional(),
});

export function createScoutTools(opts: {
  cfg: ScoutToolsConfig;
  pool: pg.Pool;
  mentionKey?: string;
  author?: string;
  storeSwitchOn: () => Promise<boolean>;
  envSwitchOn?: ScoutEnvSwitchOn;
  client?: ScoutClient;
}) {
  const client = opts.client ?? new ScoutClient(opts.cfg, opts.pool);
  const cap = opts.cfg.scoutClaimantCap;
  const lim = (n?: number) => clampLimit(n ?? 25, opts.cfg.scoutLimitMax);

  const run = async (tool: string, raw: boolean, fn: () => Promise<unknown>) => {
    const started = Date.now();
    const done = (ok: boolean) => {
      log.info({ name: tool, ms: Date.now() - started, ok, mention_key: opts.mentionKey }, "tool call");
    };
    if (!opts.cfg.scoutEnabled) {
      done(false);
      return new ScoutToolError("DISABLED", "graph lookup unavailable right now").toPublic();
    }
    if (await scoutSwitchBlocked(opts.storeSwitchOn, opts.envSwitchOn)) {
      done(false);
      return new ScoutToolError("SWITCH", "graph lookup unavailable right now").toPublic();
    }
    const gate = await checkScoutBudgets(opts.pool, opts.cfg, {
      mentionKey: opts.mentionKey,
      author: opts.author,
      raw,
    });
    if (gate.blocked) {
      done(false);
      return budgetError(gate.reason ?? "budget").toPublic();
    }
    try {
      const out = await fn();
      done(true);
      return out;
    } catch (e) {
      done(false);
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
            schema: getActiveScoutSchema(),
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
    rank_users: {
      description:
        "Rank users by tags applied, tags received, posts, followers, following, or tags_applied_per_post (lurker ratio: tags applied ÷ max(posts,1)). Evidence counts only.",
      parameters: rankUsersParams,
      execute: (args: z.infer<typeof rankUsersParams>) =>
        run("rank_users", false, async () => {
          const time = defaultTimeRange(args.time_range);
          const order = args.order ?? "desc";
          const q = rankUsersTemplate({
            metric: args.metric,
            order,
            time,
            limit: Math.min(50, lim(args.limit ?? 10)),
          });
          const { envelope } = await client.query({
            cypher: q.cypher,
            params: q.params,
            limit: q.limit,
            tool: "rank_users",
            mentionKey: opts.mentionKey,
          });
          const users = asRows(envelope.results).map((r) => ({
            pubky: str(r.pubky),
            name: str(r.name) || undefined,
            value: num(r[args.metric]),
            tags_applied: num(r.tags_applied),
            posts: num(r.posts),
            followers: num(r.followers),
          }));
          return {
            ...meta("rank_users", envelope.truncated, envelope.notes, {
              time_range: time,
              filters: { metric: args.metric, order, limit: q.limit },
            }),
            users,
            truncated: envelope.truncated,
          };
        }),
    },
    recommend_follows: {
      description:
        "Users followed by at least two of the subject's follows that the subject does not follow. Rows: pubky, name, mutual_followers_count, shared_tags, post_count_30d. Evidence fields only.",
      parameters: recommendFollowsParams,
      execute: (args: z.infer<typeof recommendFollowsParams>) =>
        run("recommend_follows", false, async () => {
          const id = parseUserPk(args.pubky);
          const limit = Math.min(FOLLOW_TOOL_LIMIT, lim(args.limit ?? 10));
          const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
          const q = recommendFollowsTemplate(id, since, limit);
          const { envelope } = await client.query({
            cypher: q.cypher,
            params: q.params,
            limit: q.limit,
            tool: "recommend_follows",
            mentionKey: opts.mentionKey,
          });
          const candidates = asRows(envelope.results).map((r) => ({
            pubky: str(r.pubky),
            name: str(r.name) || undefined,
            mutual_followers_count: num(r.mutual_followers_count),
            post_count_30d: num(r.post_count_30d),
          }));
          const ids = [id, ...candidates.map((c) => c.pubky)].filter(Boolean);
          let tagMap = new Map<string, string[]>();
          let tagTrunc = false;
          let tagNotes: string[] = [];
          if (ids.length) {
            const tq = userTagLabelsTemplate(ids);
            const tags = await client.query({
              cypher: tq.cypher,
              params: tq.params,
              limit: tq.limit,
              tool: "recommend_follows",
              mentionKey: opts.mentionKey,
            });
            tagTrunc = tags.envelope.truncated;
            tagNotes = tags.envelope.notes ?? [];
            for (const r of asRows(tags.envelope.results)) {
              const labels = [...new Set([...strArr(r.received), ...strArr(r.applied)].filter(Boolean))];
              tagMap.set(str(r.pubky), labels);
            }
          }
          const subjectTags = new Set(tagMap.get(id) ?? []);
          const users = candidates
            .map((c) => {
              const shared_tags = (tagMap.get(c.pubky) ?? []).filter((l) => subjectTags.has(l));
              return { ...c, shared_tags };
            })
            .sort((a, b) => {
              if (b.mutual_followers_count !== a.mutual_followers_count) {
                return b.mutual_followers_count - a.mutual_followers_count;
              }
              if (b.shared_tags.length !== a.shared_tags.length) return b.shared_tags.length - a.shared_tags.length;
              return b.post_count_30d - a.post_count_30d;
            })
            .slice(0, limit);
          const truncated = envelope.truncated || tagTrunc;
          return {
            ...meta("recommend_follows", truncated, [...(envelope.notes ?? []), ...tagNotes], {
              time_range: { since, until: Date.now() },
              filters: { pubky: id, limit },
            }),
            users,
            truncated,
          };
        }),
    },
    stale_follows: {
      description:
        "Accounts the subject follows whose latest post indexed_at is older than inactive_days (default 60), or who have no posts. Rows: pubky, name, last_post_at, follows_back. Evidence fields only.",
      parameters: staleFollowsParams,
      execute: (args: z.infer<typeof staleFollowsParams>) =>
        run("stale_follows", false, async () => {
          const id = parseUserPk(args.pubky);
          const inactiveDays = Math.min(3650, Math.max(1, Math.floor(args.inactive_days ?? 60)));
          const cutoff = Date.now() - inactiveDays * 24 * 60 * 60 * 1000;
          const limit = Math.min(FOLLOW_TOOL_LIMIT, lim(args.limit ?? 10));
          const q = staleFollowsTemplate(id, cutoff, limit);
          const { envelope } = await client.query({
            cypher: q.cypher,
            params: q.params,
            limit: q.limit,
            tool: "stale_follows",
            mentionKey: opts.mentionKey,
          });
          const users = asRows(envelope.results)
            .map((r) => ({
              pubky: str(r.pubky),
              name: str(r.name) || undefined,
              last_post_at: r.last_post_at == null || r.last_post_at === "" ? undefined : num(r.last_post_at),
              follows_back: r.follows_back === true || r.follows_back === "true" || num(r.follows_back) > 0,
            }))
            .sort((a, b) => {
              if (a.last_post_at == null && b.last_post_at == null) return 0;
              if (a.last_post_at == null) return -1;
              if (b.last_post_at == null) return 1;
              return a.last_post_at - b.last_post_at;
            })
            .slice(0, limit);
          return {
            ...meta("stale_follows", envelope.truncated, envelope.notes, {
              time_range: { since: 0, until: cutoff },
              filters: { pubky: id, inactive_days: inactiveDays, limit },
            }),
            users,
            truncated: envelope.truncated,
          };
        }),
    },
    follow_path: {
      description:
        "Shortest FOLLOWS hop chain(s) from a to b (max 3 hops). Returns pubky ids with names when present and how many alternative shortest paths exist. Use for 'how am I connected to X' / 2-hop trust graph. Evidence only, not a trust verdict.",
      parameters: followPathParams,
      execute: (args: z.infer<typeof followPathParams>) =>
        run("follow_path", false, async () => {
          const a = parseUserPk(args.a);
          const b = parseUserPk(args.b);
          const maxHops = Math.min(FOLLOW_PATH_MAX_HOPS, Math.max(1, args.max_hops ?? FOLLOW_PATH_MAX_HOPS));
          const limit = Math.min(FOLLOW_TOOL_LIMIT, lim(args.limit ?? 10));
          if (a === b) {
            return {
              ...meta("follow_path", false, [], {
                time_range: defaultTimeRange(),
                filters: { a, b, max_hops: maxHops, limit },
              }),
              paths: [{ hop_ids: [a], hop_names: [""], hops: 0 }],
              path_count: 1,
              hops: 0,
              truncated: false,
            };
          }
          const cQ = followPathCountTemplate(a, b, maxHops);
          const pQ = followPathTemplate(a, b, maxHops, limit);
          const c = await client.query({
            cypher: cQ.cypher,
            params: cQ.params,
            limit: 1,
            tool: "follow_path",
            mentionKey: opts.mentionKey,
          });
          const p = await client.query({
            cypher: pQ.cypher,
            params: pQ.params,
            limit: pQ.limit,
            tool: "follow_path",
            mentionKey: opts.mentionKey,
          });
          const cr = asRows(c.envelope.results)[0] ?? {};
          const path_count = num(cr.path_count);
          const hops = num(cr.hops);
          const paths = asRows(p.envelope.results).map((r) => ({
            hop_ids: strArr(r.hop_ids),
            hop_names: strArr(r.hop_names),
            hops: num(r.hops),
          }));
          const truncated = c.envelope.truncated || p.envelope.truncated;
          return {
            ...meta("follow_path", truncated, p.envelope.notes, {
              time_range: defaultTimeRange(),
              filters: { a, b, max_hops: maxHops, limit },
            }),
            paths,
            path_count,
            hops,
            truncated,
          };
        }),
    },
    trust_view: {
      description:
        "Tag claim counts on a user (target) or on posts matching a topic, globally and restricted to claimants in the asker's 1–2 hop FOLLOWS graph. Returns both labelled series. Tag counts are claims by taggers, not verdicts. Use when the ask is 'in my network'.",
      parameters: trustViewParams,
      execute: (args: z.infer<typeof trustViewParams>) =>
        run("trust_view", false, async () => {
          const asker = parseUserPk(args.asker);
          const hops = Math.min(TRUST_VIEW_MAX_HOPS, Math.max(1, args.hops ?? 2));
          const time = defaultTimeRange(args.time_range);
          const target = args.target?.trim() ? parseUserPk(args.target) : "";
          const topic = args.topic?.trim() ?? "";
          if ((target && topic) || (!target && !topic)) {
            throw new ScoutToolError("BAD_INPUT", "provide exactly one of target or topic");
          }
          const q = target
            ? trustViewUserTemplate(asker, target, hops, time, lim(args.limit ?? 20))
            : trustViewTopicTemplate(asker, topic, hops, time, lim(args.limit ?? 20));
          const { envelope } = await client.query({
            cypher: q.cypher,
            params: q.params,
            limit: q.limit,
            tool: "trust_view",
            mentionKey: opts.mentionKey,
          });
          const claims = asRows(envelope.results).map((r) => ({
            label: str(r.label),
            global_count: num(r.global_count),
            graph_count: num(r.graph_count),
            claimant_ids: capIds(strArr(r.claimant_ids), cap),
          }));
          return {
            ...meta("trust_view", envelope.truncated, envelope.notes, {
              time_range: time,
              graph_scope: { pubky: asker, hops },
              filters: { asker, target: target || undefined, topic: topic || undefined, hops },
            }),
            claims,
            truncated: envelope.truncated,
          };
        }),
    },
    top_posts: {
      description:
        "Posts with the most bookmarks, reposts, or replies in a time window (optional tag-label filter). The graph has no likes; this is the honest substitute for trending/most-liked. Returns URIs, authors, counts, content preview. Counts are evidence, not popularity verdicts.",
      parameters: topPostsParams,
      execute: (args: z.infer<typeof topPostsParams>) =>
        run("top_posts", false, async () => {
          const time = defaultTimeRange(args.time_range);
          const topic = args.topic ? args.topic.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 20) : "";
          const q = topPostsTemplate({
            metric: args.metric,
            time,
            topic,
            limit: lim(args.limit ?? 10),
          });
          const { envelope } = await client.query({
            cypher: q.cypher,
            params: q.params,
            limit: q.limit,
            tool: "top_posts",
            mentionKey: opts.mentionKey,
          });
          const posts = asRows(envelope.results).map((r) => ({
            uri: postUri(str(r.author_id), str(r.post_id)),
            author_id: str(r.author_id),
            author_name: str(r.author_name) || undefined,
            indexed_at: num(r.indexed_at),
            score: num(r.score),
            metric: args.metric,
            content_preview: str(r.content).slice(0, 140),
          }));
          return {
            ...meta("top_posts", envelope.truncated, envelope.notes, {
              time_range: time,
              filters: { metric: args.metric, topic: topic || undefined },
            }),
            posts,
            truncated: envelope.truncated,
          };
        }),
    },
    mentions_of: {
      description:
        "Posts that MENTIONED a pubky in the time window, with authors and URIs. Use for 'who mentioned me this week'. Evidence rows only.",
      parameters: mentionsOfParams,
      execute: (args: z.infer<typeof mentionsOfParams>) =>
        run("mentions_of", false, async () => {
          const id = parseUserPk(args.pubky);
          const time = defaultTimeRange(args.time_range);
          const q = mentionsOfTemplate(id, time, lim(args.limit ?? 25));
          const { envelope } = await client.query({
            cypher: q.cypher,
            params: q.params,
            limit: q.limit,
            tool: "mentions_of",
            mentionKey: opts.mentionKey,
          });
          const posts = asRows(envelope.results).map((r) => ({
            uri: postUri(str(r.author_id), str(r.post_id)),
            author_id: str(r.author_id),
            author_name: str(r.author_name) || undefined,
            indexed_at: num(r.indexed_at),
          }));
          return {
            ...meta("mentions_of", envelope.truncated, envelope.notes, {
              time_range: time,
              filters: { pubky: id },
            }),
            posts,
            truncated: envelope.truncated,
          };
        }),
    },
    profile_card: {
      description:
        "Factual snapshot of a pubky: first indexed, post count, followers/following, top tags received and applied (label+count), most-replied-to accounts (top 5), mutual follows with asker when supplied, muted_count as an aggregate only (never who). Claims not character judgments.",
      parameters: profileCardParams,
      execute: (args: z.infer<typeof profileCardParams>) =>
        run("profile_card", false, async () => {
          const id = parseUserPk(args.pubky);
          const asker = args.asker?.trim() ? parseUserPk(args.asker) : "";
          const time = defaultTimeRange();
          const snapQ = profileSnapshotTemplate(id);
          const folQ = identityFollowersTemplate(id);
          const fingQ = identityFollowingTemplate(id);
          const recvQ = identityTagsTemplate(id, time, lim(10));
          const appQ = profileTagsAppliedTemplate(id, lim(10));
          const repQ = profileRepliedToTemplate(id, 5);
          const snap = await client.query({
            cypher: snapQ.cypher,
            params: snapQ.params,
            limit: 1,
            tool: "profile_card",
            mentionKey: opts.mentionKey,
          });
          const fol = await client.query({
            cypher: folQ.cypher,
            params: folQ.params,
            limit: 1,
            tool: "profile_card",
            mentionKey: opts.mentionKey,
          });
          const fing = await client.query({
            cypher: fingQ.cypher,
            params: fingQ.params,
            limit: 1,
            tool: "profile_card",
            mentionKey: opts.mentionKey,
          });
          const recv = await client.query({
            cypher: recvQ.cypher,
            params: recvQ.params,
            limit: recvQ.limit,
            tool: "profile_card",
            mentionKey: opts.mentionKey,
          });
          const app = await client.query({
            cypher: appQ.cypher,
            params: appQ.params,
            limit: appQ.limit,
            tool: "profile_card",
            mentionKey: opts.mentionKey,
          });
          const rep = await client.query({
            cypher: repQ.cypher,
            params: repQ.params,
            limit: repQ.limit,
            tool: "profile_card",
            mentionKey: opts.mentionKey,
          });
          let mutual: { asker_follows_target: boolean; target_follows_asker: boolean } | undefined;
          let mutTrunc = false;
          if (asker) {
            const mQ = profileMutualTemplate(asker, id);
            const m = await client.query({
              cypher: mQ.cypher,
              params: mQ.params,
              limit: 1,
              tool: "profile_card",
              mentionKey: opts.mentionKey,
            });
            mutTrunc = m.envelope.truncated;
            const mr = asRows(m.envelope.results)[0] ?? {};
            mutual = {
              asker_follows_target: Boolean(mr.asker_follows_target),
              target_follows_asker: Boolean(mr.target_follows_asker),
            };
          }
          const s0 = asRows(snap.envelope.results)[0] ?? {};
          const tags_received = asRows(recv.envelope.results).map((r) => ({
            label: str(r.label),
            count: num(r.count),
            claimant_ids: capIds(strArr(r.claimant_ids), cap),
          }));
          const tags_applied = asRows(app.envelope.results).map((r) => ({
            label: str(r.label),
            count: num(r.count),
          }));
          const most_replied_to = asRows(rep.envelope.results).map((r) => ({
            pubky: str(r.pubky),
            name: str(r.name) || undefined,
            replies: num(r.replies),
          }));
          const truncated =
            snap.envelope.truncated ||
            fol.envelope.truncated ||
            fing.envelope.truncated ||
            recv.envelope.truncated ||
            app.envelope.truncated ||
            rep.envelope.truncated ||
            mutTrunc;
          return {
            ...meta("profile_card", truncated, recv.envelope.notes, {
              time_range: time,
              filters: { pubky: id, asker: asker || undefined },
            }),
            pubky: id,
            name: str(s0.name) || undefined,
            first_indexed_at: s0.indexed_at == null || s0.indexed_at === "" ? undefined : num(s0.indexed_at),
            posts: num(s0.posts),
            followers: num(asRows(fol.envelope.results)[0]?.followers),
            following: num(asRows(fing.envelope.results)[0]?.following),
            tags_received,
            tags_applied,
            most_replied_to,
            mutual,
            muted_count: num(s0.muted_count),
            truncated,
          };
        }),
    },
  };
}

export { claimSchema };
