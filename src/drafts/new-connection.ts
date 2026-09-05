import type { Config } from "../config.js";
import { profileAppUrl } from "../links.js";
import { composeDraftProse, type DraftCompleteFn } from "./compose.js";
import { DraftRejectedError, finishDraft, isToolError, sanitizeDraftLabel } from "./finish.js";
import { asPosts, postLink } from "./scout-util.js";
import type { ScoutTools } from "./scout-util.js";
import type { Draft } from "./types.js";
import { draftWindow, filterWindowPosts, DEFAULT_WINDOW_DAYS } from "./window.js";

export async function generateNewConnection(opts: {
  scout: ScoutTools;
  appUrl: string;
  cfg?: Config;
  complete?: DraftCompleteFn;
  windowDays?: number;
  nowMs?: number;
  botPk?: string;
}): Promise<Draft> {
  const window = draftWindow(opts.nowMs ?? Date.now(), opts.windowDays ?? DEFAULT_WINDOW_DAYS);
  const emerging = await opts.scout.get_emerging_topics.execute({});
  if (isToolError(emerging)) throw new DraftRejectedError("new_connection", "scout unavailable");
  const topics = Array.isArray((emerging as { topics?: unknown }).topics)
    ? ((emerging as { topics: Array<{ label?: string; delta?: number; distinct_taggers?: number }> }).topics ?? [])
    : [];
  const label = sanitizeDraftLabel(topics.find((t) => t.label)?.label ?? "");
  if (!label) throw new DraftRejectedError("new_connection", "none: Scout has no emerging topic");
  const postsRaw = await opts.scout.search_posts.execute({
    query: label,
    tags: [label],
    limit: 12,
    time_range: { since: window.sinceMs, until: window.untilMs },
  });
  if (isToolError(postsRaw)) throw new DraftRejectedError("new_connection", "scout unavailable");
  const posts = filterWindowPosts(asPosts(postsRaw), { window, botPk: opts.botPk });
  const authors = [
    ...new Set(
      posts.map((p) => p.author_id).filter((a): a is string => typeof a === "string" && /^[a-z0-9]{52}$/.test(a)),
    ),
  ];
  if (authors.length < 2 || !posts[0]?.uri) {
    throw new DraftRejectedError("new_connection", "none: need two authors and a post in the window");
  }
  const a = authors[0];
  const b = authors[1];
  const rel = await opts.scout.get_relationship.execute({ pubky_a: a, pubky_b: b });
  const relOk = !isToolError(rel);
  const relObj = relOk && rel && typeof rel === "object" ? (rel as Record<string, unknown>) : {};
  const uris = [
    ...posts.map((p) => p.uri).filter((u): u is string => Boolean(u)),
    `pubky://${a}`,
    `pubky://${b}`,
  ];
  const example = posts[0]?.uri ? postLink(posts[0].uri, opts.appUrl) : "";
  const notes = [
    `Rising tag: ${label}`,
    `Author A: ${profileAppUrl(a, opts.appUrl)}`,
    `Author B: ${profileAppUrl(b, opts.appUrl)}`,
    example ? `Example post: ${example}` : "",
    relOk
      ? `Follow overlap: a_follows_b=${Boolean(relObj.a_follows_b)} b_follows_a=${Boolean(relObj.b_follows_a)} shared_taggers=${Number(relObj.shared_taggers) || 0}`
      : "relationship lookup unavailable",
  ]
    .filter(Boolean)
    .join("\n");
  const body = await composeDraftProse({
    format: "new_connection",
    cfg: opts.cfg,
    complete: opts.complete,
    noneFallback: "no connection to describe",
    evidenceNotes: notes,
    instruction: [
      "Write one or two sentences explaining the graph coincidence around the rising tag.",
      "Name both people via their profile links and include the example post link.",
      "This is a graph coincidence, not an introduction you are making. No tuple dump.",
    ].join(" "),
  });
  return finishDraft({
    format: "new_connection",
    title: `New connection: ${label}`,
    body,
    uris,
    appUrl: opts.appUrl,
    tool_trace: [
      { tool: "get_emerging_topics", topics: topics.length, label, window },
      { tool: "search_posts", query: label, posts: posts.length },
      { tool: "get_relationship", pubky_a: a, pubky_b: b, ok: relOk },
    ],
  });
}
