import { profileAppUrl } from "../links.js";
import { DraftRejectedError, finishDraft, isToolError, sanitizeDraftLabel } from "./finish.js";
import { asPosts, postLink } from "./scout-util.js";
import type { ScoutTools } from "./scout-util.js";
import type { Draft } from "./types.js";

export async function generateNewConnection(opts: {
  scout: ScoutTools;
  appUrl: string;
}): Promise<Draft> {
  const emerging = await opts.scout.get_emerging_topics.execute({});
  if (isToolError(emerging)) throw new DraftRejectedError("new_connection", "scout unavailable");
  const topics = Array.isArray((emerging as { topics?: unknown }).topics)
    ? ((emerging as { topics: Array<{ label?: string; delta?: number; distinct_taggers?: number }> }).topics ?? [])
    : [];
  const label = sanitizeDraftLabel(topics.find((t) => t.label)?.label ?? "");
  if (!label) throw new DraftRejectedError("new_connection", "no emerging topic");
  const postsRaw = await opts.scout.search_posts.execute({ query: label, tags: [label], limit: 8 });
  if (isToolError(postsRaw)) throw new DraftRejectedError("new_connection", "scout unavailable");
  const posts = asPosts(postsRaw);
  const authors = [
    ...new Set(
      posts.map((p) => p.author_id).filter((a): a is string => typeof a === "string" && /^[a-z0-9]{52}$/.test(a)),
    ),
  ];
  if (authors.length < 2 || !posts[0]?.uri) {
    throw new DraftRejectedError("new_connection", "need two authors and a post URI");
  }
  const a = authors[0];
  const b = authors[1];
  const rel = await opts.scout.get_relationship.execute({ pubky_a: a, pubky_b: b });
  const relOk = !isToolError(rel);
  const relObj = relOk && rel && typeof rel === "object" ? (rel as Record<string, unknown>) : {};
  const uris = posts.map((p) => p.uri).filter((u): u is string => Boolean(u));
  const follows = relOk
    ? `a_follows_b=${Boolean(relObj.a_follows_b)} b_follows_a=${Boolean(relObj.b_follows_a)} shared_taggers=${Number(relObj.shared_taggers) || 0}`
    : "relationship lookup unavailable";
  const example = posts[0]?.uri ? postLink(posts[0].uri, opts.appUrl) : "";
  const body = [
    `New connection around rising tag "${label}" (distinct-tagger delta, not a social verdict).`,
    "",
    `${profileAppUrl(a, opts.appUrl)} and ${profileAppUrl(b, opts.appUrl)} both appear on recent posts with that tag.`,
    `Follow/tag overlap: ${follows}.`,
    example ? `Example post: ${example}` : "",
    "",
    "My read: this is a graph coincidence worth a look, not an introduction I am making.",
  ]
    .filter((l) => l !== "")
    .join("\n");
  return finishDraft({
    format: "new_connection",
    title: `New connection: ${label}`,
    body,
    uris,
    tool_trace: [
      { tool: "get_emerging_topics", topics: topics.length, label },
      { tool: "search_posts", query: label, posts: posts.length },
      { tool: "get_relationship", pubky_a: a, pubky_b: b, ok: relOk },
    ],
  });
}
