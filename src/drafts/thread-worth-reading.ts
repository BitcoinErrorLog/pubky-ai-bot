import { DraftRejectedError, finishDraft, isToolError } from "./finish.js";
import { asPosts, postLink } from "./scout-util.js";
import type { ScoutTools } from "./scout-util.js";
import type { Draft } from "./types.js";

export async function generateThreadWorthReading(opts: {
  scout: ScoutTools;
  appUrl: string;
  topic?: string;
}): Promise<Draft> {
  const topic = opts.topic?.trim() || undefined;
  const raw = await opts.scout.top_posts.execute({ metric: "replies", limit: 8, topic });
  if (isToolError(raw)) throw new DraftRejectedError("thread_worth_reading", "scout unavailable");
  const posts = asPosts(raw);
  const top = posts.find((p) => p.uri);
  if (!top?.uri) throw new DraftRejectedError("thread_worth_reading", "no evidence URI");
  const threadRaw = await opts.scout.scout_get_thread.execute({ uri: top.uri, depth: 3 });
  const threadPosts = isToolError(threadRaw) ? [] : asPosts(threadRaw);
  const uris = [top.uri, ...threadPosts.map((p) => p.uri).filter((u): u is string => Boolean(u))];
  const score = typeof top.score === "number" ? top.score : undefined;
  const body = [
    "The thread worth reading, by reply count on the public graph (counts are evidence, not a popularity verdict).",
    "",
    postLink(top.uri, opts.appUrl),
    top.content_preview ? `Preview: ${top.content_preview.replace(/\s+/g, " ").slice(0, 180)}` : "",
    score !== undefined ? `Reply count in the window: ${score}.` : "",
    threadPosts.length > 0
      ? `Ancestor/descendant sample: ${threadPosts.length} post${threadPosts.length === 1 ? "" : "s"} in the replied chain.`
      : "I did not expand a replied chain for this post.",
    "",
    "My read: this is the busiest thread in the window I queried, not the one I endorse.",
  ]
    .filter((l) => l !== "")
    .join("\n");
  return finishDraft({
    format: "thread_worth_reading",
    title: "The thread worth reading",
    body,
    uris,
    tool_trace: [
      { tool: "top_posts", metric: "replies", topic: topic ?? null, posts: posts.length },
      { tool: "scout_get_thread", uri: top.uri, posts: threadPosts.length },
    ],
  });
}
