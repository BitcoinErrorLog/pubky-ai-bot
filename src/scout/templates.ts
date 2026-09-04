import type { TimeRange } from "./types.js";

export const GOLDEN_LABELS = ["User", "Post", "File"] as const;
export const GOLDEN_RELS = [
  "FOLLOWS",
  "AUTHORED",
  "TAGGED",
  "REPLIED",
  "REPOSTED",
  "BOOKMARKED",
  "MENTIONED",
  "MUTED",
] as const;

export interface BoundQuery {
  name: string;
  cypher: string;
  params: Record<string, unknown>;
  limit: number;
}

function timeWhere(alias: string): string {
  return `${alias}.indexed_at >= $since AND ${alias}.indexed_at <= $until`;
}

export function searchPostsTemplate(args: {
  query: string;
  time: TimeRange;
  authors: string[];
  tags: string[];
  limit: number;
}): BoundQuery {
  return {
    name: "search_posts",
    limit: args.limit,
    params: {
      q: args.query,
      since: args.time.since,
      until: args.time.until,
      authors: args.authors,
      tags: args.tags,
      limit: args.limit,
    },
    cypher: `MATCH (a:User)-[:AUTHORED]->(p:Post)
WHERE toLower(p.content) CONTAINS toLower($q)
AND ${timeWhere("p")}
AND (size($authors) = 0 OR a.id IN $authors)
OPTIONAL MATCH (tg:User)-[t:TAGGED]->(p)
WITH a, p, collect(DISTINCT t.label) AS labels, collect(DISTINCT tg.id) AS taggers, collect(t.label) AS allLabels
WHERE size($tags) = 0 OR any(x IN $tags WHERE x IN labels)
RETURN a.id AS author_id, a.name AS author_name, p.id AS post_id, p.content AS content, p.kind AS kind, p.indexed_at AS indexed_at, labels, taggers
ORDER BY p.indexed_at DESC
LIMIT $limit`,
  };
}

export function threadUpTemplate(postId: string, depth: number, limit: number): BoundQuery {
  return {
    name: "get_thread_up",
    limit,
    params: { post_id: postId, limit },
    cypher: `MATCH (leaf:Post {id: $post_id})
OPTIONAL MATCH path = (leaf)-[:REPLIED*0..${depth}]->(anc:Post)
WITH leaf, collect(DISTINCT anc) AS ancs
UNWIND (ancs + [leaf]) AS p
MATCH (a:User)-[:AUTHORED]->(p)
OPTIONAL MATCH (tg:User)-[t:TAGGED]->(p)
RETURN a.id AS author_id, a.name AS author_name, p.id AS post_id, p.content AS content, p.indexed_at AS indexed_at, collect(DISTINCT t.label) AS labels, collect(DISTINCT tg.id) AS taggers, 'up' AS direction
LIMIT $limit`,
  };
}

export function threadDownTemplate(postId: string, depth: number, limit: number): BoundQuery {
  return {
    name: "get_thread_down",
    limit,
    params: { post_id: postId, limit },
    cypher: `MATCH (leaf:Post {id: $post_id})
OPTIONAL MATCH (desc:Post)-[:REPLIED*0..${depth}]->(leaf)
WITH leaf, collect(DISTINCT desc) AS descs
UNWIND descs AS p
MATCH (a:User)-[:AUTHORED]->(p)
OPTIONAL MATCH (tg:User)-[t:TAGGED]->(p)
RETURN a.id AS author_id, a.name AS author_name, p.id AS post_id, p.content AS content, p.indexed_at AS indexed_at, collect(DISTINCT t.label) AS labels, collect(DISTINCT tg.id) AS taggers, 'down' AS direction
LIMIT $limit`,
  };
}

export function identityPostsTemplate(pubky: string, time: TimeRange): BoundQuery {
  return {
    name: "identity_posts",
    limit: 1,
    params: { id: pubky, since: time.since, until: time.until },
    cypher: `MATCH (u:User {id: $id})
OPTIONAL MATCH (u)-[:AUTHORED]->(p:Post)
WHERE p.indexed_at >= $since AND p.indexed_at <= $until
RETURN u.id AS id, u.name AS name, count(p) AS posts
LIMIT 1`,
  };
}

export function identityFollowersTemplate(pubky: string): BoundQuery {
  return {
    name: "identity_followers",
    limit: 1,
    params: { id: pubky },
    cypher: `MATCH (u:User {id: $id})
OPTIONAL MATCH (u)<-[f:FOLLOWS]-(:User)
RETURN count(f) AS followers
LIMIT 1`,
  };
}

export function identityFollowingTemplate(pubky: string): BoundQuery {
  return {
    name: "identity_following",
    limit: 1,
    params: { id: pubky },
    cypher: `MATCH (u:User {id: $id})
OPTIONAL MATCH (u)-[f:FOLLOWS]->(:User)
RETURN count(f) AS following
LIMIT 1`,
  };
}

export function identityTagsTemplate(pubky: string, time: TimeRange, limit: number): BoundQuery {
  return {
    name: "identity_tags",
    limit,
    params: { id: pubky, since: time.since, until: time.until, limit },
    cypher: `MATCH (tagger:User)-[t:TAGGED]->(u:User {id: $id})
WHERE t.indexed_at >= $since AND t.indexed_at <= $until
RETURN t.label AS label, count(*) AS count, collect(DISTINCT tagger.id) AS claimant_ids, sum(CASE WHEN tagger.id = $id THEN 1 ELSE 0 END) > 0 AS self_claim
ORDER BY count DESC
LIMIT $limit`,
  };
}

export function topicPostsTemplate(args: {
  topic: string;
  time: TimeRange;
  scopeId: string;
  hops: number;
  limit: number;
}): BoundQuery {
  const hop = Math.min(3, Math.max(1, args.hops));
  return {
    name: "topic_brief",
    limit: args.limit,
    params: {
      topic: args.topic,
      since: args.time.since,
      until: args.time.until,
      scope_id: args.scopeId,
      limit: args.limit,
    },
    cypher: `MATCH (a:User)-[:AUTHORED]->(p:Post)
WHERE ${timeWhere("p")}
AND (toLower(p.content) CONTAINS toLower($topic) OR EXISTS { MATCH (:User)-[tg:TAGGED]->(p) WHERE toLower(tg.label) = toLower($topic) })
AND ($scope_id = '' OR a.id = $scope_id OR EXISTS { MATCH (s:User {id: $scope_id})-[:FOLLOWS*1..${hop}]->(a) })
OPTIONAL MATCH (tg:User)-[t:TAGGED]->(p)
RETURN a.id AS author_id, a.name AS author_name, p.id AS post_id, p.content AS content, p.indexed_at AS indexed_at, collect(DISTINCT t.label) AS labels, collect(DISTINCT tg.id) AS taggers
ORDER BY p.indexed_at DESC
LIMIT $limit`,
  };
}

export function whatChangedTemplate(topic: string, since: number, until: number, limit: number): BoundQuery {
  return {
    name: "what_changed",
    limit,
    params: { topic, since, until, limit },
    cypher: `MATCH (a:User)-[:AUTHORED]->(p:Post)
WHERE p.indexed_at >= $since AND p.indexed_at <= $until
AND (toLower(p.content) CONTAINS toLower($topic) OR EXISTS { MATCH (:User)-[tg:TAGGED]->(p) WHERE toLower(tg.label) = toLower($topic) })
OPTIONAL MATCH (tg:User)-[t:TAGGED]->(p)
WHERE t.indexed_at >= $since
RETURN a.id AS author_id, p.id AS post_id, p.content AS content, p.indexed_at AS indexed_at, collect(DISTINCT {label: t.label, tagger: tg.id}) AS claims
ORDER BY p.indexed_at DESC
LIMIT $limit`,
  };
}

export const RELATED = ["replied", "reposted", "mentioned", "tagged", "same_author"] as const;
export type RelatedKind = (typeof RELATED)[number];

export function relatedPostsTemplate(author: string, postId: string, kind: RelatedKind, limit: number): BoundQuery {
  const params = { author, post_id: postId, limit };
  const bodies: Record<RelatedKind, string> = {
    replied: `MATCH (root:Post {id: $post_id})
MATCH (p:Post)-[:REPLIED]->(root)
MATCH (a:User)-[:AUTHORED]->(p)
RETURN a.id AS author_id, p.id AS post_id, p.content AS content, p.indexed_at AS indexed_at, 'replied' AS relationship
ORDER BY p.indexed_at DESC LIMIT $limit`,
    reposted: `MATCH (root:Post {id: $post_id})
MATCH (p:Post)-[:REPOSTED]->(root)
MATCH (a:User)-[:AUTHORED]->(p)
RETURN a.id AS author_id, p.id AS post_id, p.content AS content, p.indexed_at AS indexed_at, 'reposted' AS relationship
ORDER BY p.indexed_at DESC LIMIT $limit`,
    mentioned: `MATCH (root:Post {id: $post_id})
MATCH (root)-[:MENTIONED]->(u:User)
MATCH (a:User)-[:AUTHORED]->(p:Post)-[:MENTIONED]->(u)
WHERE p.id <> $post_id
RETURN a.id AS author_id, p.id AS post_id, p.content AS content, p.indexed_at AS indexed_at, 'mentioned' AS relationship
ORDER BY p.indexed_at DESC LIMIT $limit`,
    tagged: `MATCH (root:Post {id: $post_id})<-[rt:TAGGED]-(:User)
MATCH (p:Post)<-[t:TAGGED]-(:User)
WHERE t.label = rt.label AND p.id <> $post_id
MATCH (a:User)-[:AUTHORED]->(p)
RETURN a.id AS author_id, p.id AS post_id, p.content AS content, p.indexed_at AS indexed_at, 'tagged' AS relationship
ORDER BY p.indexed_at DESC LIMIT $limit`,
    same_author: `MATCH (root:Post {id: $post_id})<-[:AUTHORED]-(u:User)
MATCH (u)-[:AUTHORED]->(p:Post)
WHERE p.id <> $post_id
RETURN u.id AS author_id, p.id AS post_id, p.content AS content, p.indexed_at AS indexed_at, 'same_author' AS relationship
ORDER BY p.indexed_at DESC LIMIT $limit`,
  };
  return { name: `related_${kind}`, limit, params, cypher: bodies[kind] };
}

export function relationshipFollowsTemplate(a: string, b: string): BoundQuery {
  return {
    name: "relationship_follows",
    limit: 1,
    params: { a, b },
    cypher: `OPTIONAL MATCH (ua:User {id: $a})-[ab:FOLLOWS]->(ub:User {id: $b})
OPTIONAL MATCH (ub2:User {id: $b})-[ba:FOLLOWS]->(ua2:User {id: $a})
RETURN count(ab) > 0 AS a_follows_b, count(ba) > 0 AS b_follows_a
LIMIT 1`,
  };
}

export function relationshipTagsTemplate(a: string, b: string, limit: number): BoundQuery {
  return {
    name: "relationship_tags",
    limit,
    params: { a, b, limit },
    cypher: `MATCH (x:User)-[t:TAGGED]->(y:User)
WHERE (x.id = $a AND y.id = $b) OR (x.id = $b AND y.id = $a)
RETURN x.id AS tagger_id, y.id AS target_id, t.label AS label, t.indexed_at AS indexed_at
ORDER BY t.indexed_at DESC
LIMIT $limit`,
  };
}

export function relationshipSharedTaggersTemplate(a: string, b: string): BoundQuery {
  return {
    name: "relationship_shared_taggers",
    limit: 1,
    params: { a, b },
    cypher: `MATCH (t:User)-[:TAGGED]->(ua:User {id: $a})
MATCH (t)-[:TAGGED]->(ub:User {id: $b})
RETURN count(DISTINCT t) AS shared_taggers
LIMIT 1`,
  };
}

export function tagLandscapeTemplate(tag: string, time: TimeRange, limit: number): BoundQuery {
  return {
    name: "tag_landscape",
    limit,
    params: { tag, since: time.since, until: time.until, limit },
    cypher: `MATCH (tagger:User)-[t:TAGGED]->(target)
WHERE toLower(t.label) = toLower($tag) AND t.indexed_at >= $since AND t.indexed_at <= $until
OPTIONAL MATCH (owner:User)-[:AUTHORED]->(target)
RETURN tagger.id AS tagger_id, target.id AS target_id, labels(target)[0] AS target_kind, owner.id AS owner_id, tagger.id = target.id AS self_claim, t.indexed_at AS indexed_at
ORDER BY t.indexed_at DESC
LIMIT $limit`,
  };
}

export function tagOverlapTemplate(tag: string, time: TimeRange, limit: number): BoundQuery {
  return {
    name: "tag_overlap",
    limit,
    params: { tag, since: time.since, until: time.until, limit },
    cypher: `MATCH (t1:User)-[x:TAGGED]->(target)<-[y:TAGGED]-(t2:User)
WHERE toLower(x.label) = toLower($tag) AND toLower(y.label) = toLower($tag)
AND x.indexed_at >= $since AND y.indexed_at >= $since
AND t1.id < t2.id
RETURN t1.id AS a, t2.id AS b, count(DISTINCT target) AS shared_targets
ORDER BY shared_targets DESC
LIMIT $limit`,
  };
}

export function emergingWindowTemplate(since: number, until: number, scopeId: string, hops: number, limit: number): BoundQuery {
  const hop = Math.min(3, Math.max(1, hops));
  return {
    name: "emerging_window",
    limit,
    params: { since, until, scope_id: scopeId, limit },
    cypher: `MATCH (tagger:User)-[t:TAGGED]->(x)
WHERE t.indexed_at >= $since AND t.indexed_at <= $until
AND ($scope_id = '' OR tagger.id = $scope_id OR EXISTS { MATCH (s:User {id: $scope_id})-[:FOLLOWS*1..${hop}]->(tagger) })
RETURN t.label AS label, count(DISTINCT tagger) AS distinct_taggers, count(*) AS uses
ORDER BY distinct_taggers DESC
LIMIT $limit`,
  };
}

export function debateMapTemplate(topic: string, time: TimeRange, limit: number): BoundQuery {
  return {
    name: "debate_map",
    limit,
    params: { topic, since: time.since, until: time.until, limit },
    cypher: `MATCH (a:User)-[:AUTHORED]->(p:Post)
WHERE p.indexed_at >= $since AND p.indexed_at <= $until
AND (toLower(p.content) CONTAINS toLower($topic) OR EXISTS { MATCH (:User)-[tg:TAGGED]->(p) WHERE toLower(tg.label) = toLower($topic) })
MATCH (r:Post)-[:REPLIED*1..5]->(p)
MATCH (b:User)-[:AUTHORED]->(r)
MATCH (a)-[t1:TAGGED]->(b)
MATCH (b)-[t2:TAGGED]->(a)
WHERE t1.label <> t2.label
RETURN a.id AS author_a, b.id AS author_b, t1.label AS label_a_on_b, t2.label AS label_b_on_a, p.id AS root_post_id, a.id AS root_author, r.id AS reply_id, p.indexed_at AS indexed_at
ORDER BY p.indexed_at DESC
LIMIT $limit`,
  };
}

export function searchUsersByNameTemplate(name: string, limit: number): BoundQuery {
  return {
    name: "search_users_by_name",
    limit,
    params: { name, limit },
    cypher: `MATCH (u:User) WHERE toLower(u.name) CONTAINS toLower($name)
OPTIONAL MATCH (u)<-[f:FOLLOWS]-()
RETURN u.id AS id, u.name AS name, u.bio AS bio, count(f) AS followers
ORDER BY followers DESC
LIMIT $limit`,
  };
}

export const RANK_USER_METRICS = [
  "tags_applied",
  "tags_received",
  "posts",
  "followers",
  "following",
  "tags_applied_per_post",
] as const;
export type RankUserMetric = (typeof RANK_USER_METRICS)[number];

export function rankUsersTemplate(args: {
  metric: RankUserMetric;
  order: "asc" | "desc";
  time: TimeRange;
  limit: number;
}): BoundQuery {
  const dir = args.order === "asc" ? "ASC" : "DESC";
  const orderExpr: Record<RankUserMetric, string> = {
    tags_applied: "tags_applied",
    tags_received: "tags_received",
    posts: "posts",
    followers: "followers",
    following: "following",
    tags_applied_per_post: "tags_applied_per_post",
  };
  const limit = Math.min(50, Math.max(1, args.limit));
  return {
    name: "rank_users",
    limit,
    params: {
      since: args.time.since,
      until: args.time.until,
      limit,
    },
    cypher: `MATCH (u:User)
OPTIONAL MATCH (u)-[ta:TAGGED]->()
WHERE ta IS NULL OR (ta.indexed_at >= $since AND ta.indexed_at <= $until)
WITH u, count(ta) AS tags_applied
OPTIONAL MATCH (u)<-[tr:TAGGED]-()
WHERE tr IS NULL OR (tr.indexed_at >= $since AND tr.indexed_at <= $until)
WITH u, tags_applied, count(tr) AS tags_received
OPTIONAL MATCH (u)-[:AUTHORED]->(p:Post)
WHERE p IS NULL OR (p.indexed_at >= $since AND p.indexed_at <= $until)
WITH u, tags_applied, tags_received, count(p) AS posts
OPTIONAL MATCH (u)<-[fol:FOLLOWS]-(:User)
WHERE fol IS NULL OR (fol.indexed_at >= $since AND fol.indexed_at <= $until)
WITH u, tags_applied, tags_received, posts, count(fol) AS followers
OPTIONAL MATCH (u)-[fing:FOLLOWS]->(:User)
WHERE fing IS NULL OR (fing.indexed_at >= $since AND fing.indexed_at <= $until)
WITH u, tags_applied, tags_received, posts, followers, count(fing) AS following,
  CASE WHEN posts < 1 THEN toFloat(tags_applied) ELSE toFloat(tags_applied) / toFloat(posts) END AS tags_applied_per_post
RETURN u.id AS pubky, u.name AS name, tags_applied, tags_received, posts, followers, following, tags_applied_per_post
ORDER BY ${orderExpr[args.metric]} ${dir}
LIMIT $limit`,
  };
}

export const FOLLOW_TOOL_LIMIT = 25;

export function recommendFollowsTemplate(pubky: string, since: number, limit: number): BoundQuery {
  const capped = Math.min(FOLLOW_TOOL_LIMIT, Math.max(1, limit));
  return {
    name: "recommend_follows",
    limit: capped,
    params: { id: pubky, since, limit: capped },
    cypher: `MATCH (subject:User {id: $id})-[:FOLLOWS]->(friend:User)-[:FOLLOWS]->(cand:User)
WHERE cand.id <> $id
AND NOT EXISTS { MATCH (subject)-[:FOLLOWS]->(cand) }
WITH cand, count(DISTINCT friend) AS mutual_followers_count
WHERE mutual_followers_count >= 2
OPTIONAL MATCH (cand)-[:AUTHORED]->(p:Post)
WHERE p.indexed_at >= $since
WITH cand, mutual_followers_count, count(p) AS post_count_30d
RETURN cand.id AS pubky, cand.name AS name, mutual_followers_count, post_count_30d
ORDER BY mutual_followers_count DESC, post_count_30d DESC
LIMIT $limit`,
  };
}

export function userTagLabelsTemplate(ids: string[]): BoundQuery {
  const limit = Math.max(1, ids.length);
  return {
    name: "user_tag_labels",
    limit,
    params: { ids, limit },
    cypher: `MATCH (u:User)
WHERE u.id IN $ids
OPTIONAL MATCH (x)-[recv:TAGGED]->(u)
OPTIONAL MATCH (u)-[app:TAGGED]->(y)
RETURN u.id AS pubky, collect(DISTINCT recv.label) AS received, collect(DISTINCT app.label) AS applied
LIMIT $limit`,
  };
}

export function staleFollowsTemplate(pubky: string, cutoff: number, limit: number): BoundQuery {
  const capped = Math.min(FOLLOW_TOOL_LIMIT, Math.max(1, limit));
  return {
    name: "stale_follows",
    limit: capped,
    params: { id: pubky, cutoff, limit: capped },
    cypher: `MATCH (subject:User {id: $id})-[:FOLLOWS]->(f:User)
OPTIONAL MATCH (f)-[:AUTHORED]->(p:Post)
WITH f, max(p.indexed_at) AS last_post_at
WHERE last_post_at IS NULL OR last_post_at < $cutoff
OPTIONAL MATCH (f)-[fb:FOLLOWS]->(:User {id: $id})
WITH f, last_post_at, count(fb) > 0 AS follows_back
RETURN f.id AS pubky, f.name AS name, last_post_at, follows_back
ORDER BY last_post_at ASC
LIMIT $limit`,
  };
}

export function allTemplateCyphers(): BoundQuery[] {
  const time = { since: 1, until: 2 };
  return [
    searchPostsTemplate({ query: "q", time, authors: [], tags: [], limit: 10 }),
    threadUpTemplate("POSTIDAAAAAAAA", 3, 25),
    threadDownTemplate("POSTIDAAAAAAAA", 3, 25),
    identityPostsTemplate("id", time),
    identityFollowersTemplate("id"),
    identityFollowingTemplate("id"),
    identityTagsTemplate("id", time, 20),
    topicPostsTemplate({ topic: "t", time, scopeId: "", hops: 1, limit: 20 }),
    whatChangedTemplate("t", 1, 2, 20),
    ...RELATED.map((k) => relatedPostsTemplate("a", "POSTIDAAAAAAAA", k, 10)),
    relationshipFollowsTemplate("a", "b"),
    relationshipTagsTemplate("a", "b", 20),
    relationshipSharedTaggersTemplate("a", "b"),
    tagLandscapeTemplate("t", time, 40),
    tagOverlapTemplate("t", time, 20),
    emergingWindowTemplate(1, 2, "", 1, 20),
    debateMapTemplate("t", time, 25),
    searchUsersByNameTemplate("n", 10),
    rankUsersTemplate({ metric: "tags_applied_per_post", order: "desc", time, limit: 10 }),
    recommendFollowsTemplate("id", 1, 10),
    userTagLabelsTemplate(["id"]),
    staleFollowsTemplate("id", 1, 10),
  ];
}
