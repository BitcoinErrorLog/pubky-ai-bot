import { extractCypherSchemaRefs } from "../scout/schema-refs.js";
import { missingTemplateDeps } from "../scout/schema-deps.js";
import { graphIndex, type ScoutGraph } from "../scout/schema-model.js";
import {
  debateMapTemplate,
  emergingWindowTemplate,
  followPathCountTemplate,
  followPathTemplate,
  identityFollowersTemplate,
  identityFollowingTemplate,
  identityPostsTemplate,
  identityTagsTemplate,
  mentionsOfTemplate,
  profileMutualTemplate,
  profileRepliedToTemplate,
  profileSnapshotTemplate,
  profileTagsAppliedTemplate,
  rankUsersTemplate,
  recommendFollowsTemplate,
  relatedPostsTemplate,
  relationshipFollowsTemplate,
  relationshipSharedTaggersTemplate,
  relationshipTagsTemplate,
  RELATED,
  searchPostsTemplate,
  searchUsersByNameTemplate,
  staleFollowsTemplate,
  tagLandscapeTemplate,
  tagOverlapTemplate,
  threadDownTemplate,
  threadUpTemplate,
  topPostsTemplate,
  TOP_POST_METRICS,
  topicPostsTemplate,
  trustViewTopicTemplate,
  trustViewUserTemplate,
  userTagLabelsTemplate,
  whatChangedTemplate,
} from "../scout/templates.js";
import type { AllowedTool } from "./intent.js";

const TIME = { since: 1, until: 2 };

/** Product-template Cypher for a typed Scout tool. Nexus / web / raw have none. */
export function cyphersForTool(tool: AllowedTool): string[] {
  switch (tool) {
    case "search_posts":
      return [searchPostsTemplate({ query: "q", time: TIME, authors: [], tags: [], limit: 10 }).cypher];
    case "scout_get_thread":
      return [threadUpTemplate("POSTIDAAAAAAAA", 3, 25).cypher, threadDownTemplate("POSTIDAAAAAAAA", 3, 25).cypher];
    case "get_identity_summary":
      return [
        identityPostsTemplate("id", TIME).cypher,
        identityFollowersTemplate("id").cypher,
        identityFollowingTemplate("id").cypher,
        identityTagsTemplate("id", TIME, 20).cypher,
      ];
    case "get_topic_brief":
      return [topicPostsTemplate({ topic: "t", time: TIME, scopeId: "", hops: 1, limit: 20 }).cypher];
    case "get_what_changed":
      return [whatChangedTemplate("t", 1, 2, 20).cypher];
    case "get_related_posts":
      return RELATED.map((k) => relatedPostsTemplate("a", "POSTIDAAAAAAAA", k, 10).cypher);
    case "get_relationship":
      return [
        relationshipFollowsTemplate("a", "b").cypher,
        relationshipTagsTemplate("a", "b", 20).cypher,
        relationshipSharedTaggersTemplate("a", "b").cypher,
      ];
    case "get_tag_landscape":
      return [tagLandscapeTemplate("t", TIME, 40).cypher, tagOverlapTemplate("t", TIME, 20).cypher];
    case "get_emerging_topics":
      return [emergingWindowTemplate(1, 2, "", 1, 20).cypher];
    case "get_debate_map":
      return [debateMapTemplate("t", TIME, 25).cypher];
    case "search_users_by_name":
      return [searchUsersByNameTemplate("n", 10).cypher];
    case "rank_users":
      return [rankUsersTemplate({ metric: "tags_applied_per_post", order: "desc", time: TIME, limit: 10 }).cypher];
    case "recommend_follows":
      return [recommendFollowsTemplate("id", 1, 10).cypher, userTagLabelsTemplate(["id"]).cypher];
    case "stale_follows":
      return [staleFollowsTemplate("id", 1, 10).cypher];
    case "follow_path":
      return [followPathCountTemplate("a", "b", 3).cypher, followPathTemplate("a", "b", 3, 10).cypher];
    case "trust_view":
      return [
        trustViewUserTemplate("a", "b", 2, TIME, 20).cypher,
        trustViewTopicTemplate("a", "t", 2, TIME, 20).cypher,
      ];
    case "top_posts":
      return TOP_POST_METRICS.map((m) => topPostsTemplate({ metric: m, time: TIME, topic: "", limit: 10 }).cypher);
    case "mentions_of":
      return [mentionsOfTemplate("id", TIME, 10).cypher];
    case "profile_card":
      return [
        profileSnapshotTemplate("id").cypher,
        profileTagsAppliedTemplate("id", 10).cypher,
        profileRepliedToTemplate("id", 5).cypher,
        profileMutualTemplate("a", "b").cypher,
      ];
    default:
      return [];
  }
}

export function validateToolAgainstSchema(
  tool: AllowedTool,
  schema: ScoutGraph,
): { ok: true } | { ok: false; missing: { labels: string[]; relTypes: string[]; properties: string[] } } {
  const cyphers = cyphersForTool(tool);
  if (cyphers.length === 0) return { ok: true };
  const labels = new Set<string>();
  const relTypes = new Set<string>();
  const properties = new Set<string>();
  for (const cypher of cyphers) {
    const refs = extractCypherSchemaRefs(cypher);
    for (const l of refs.labels) labels.add(l);
    for (const r of refs.relTypes) relTypes.add(r);
    for (const p of refs.properties) properties.add(p);
  }
  const missing = missingTemplateDeps(graphIndex(schema), {
    labels: [...labels].sort(),
    relTypes: [...relTypes].sort(),
    properties: [...properties].sort(),
  });
  if (missing.labels.length || missing.relTypes.length || missing.properties.length) {
    return { ok: false, missing };
  }
  return { ok: true };
}
