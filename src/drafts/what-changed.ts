import { DraftRejectedError, finishDraft, isToolError, sanitizeUntrustedDraftText } from "./finish.js";
import { asPosts, postLink, sinceYesterdayMs } from "./scout-util.js";
import type { ScoutTools } from "./scout-util.js";
import type { Draft } from "./types.js";

export async function generateWhatChanged(opts: {
  scout: ScoutTools;
  appUrl: string;
  topic?: string;
  nowMs?: number;
}): Promise<Draft> {
  const topic = sanitizeUntrustedDraftText(opts.topic?.trim() || "pubky") || "pubky";
  const since = sinceYesterdayMs(opts.nowMs ?? Date.now());
  const raw = await opts.scout.get_what_changed.execute({ topic, since });
  if (isToolError(raw)) throw new DraftRejectedError("what_changed", "scout unavailable");
  const posts = asPosts(raw);
  const uris = posts.map((p) => p.uri).filter((u): u is string => Boolean(u));
  if (uris.length === 0) throw new DraftRejectedError("what_changed", "no evidence URI");
  const lines = posts.slice(0, 6).map((p) => {
    const link = p.uri ? postLink(p.uri, opts.appUrl) : "";
    const preview = sanitizeUntrustedDraftText(p.content_preview ?? "").slice(0, 120);
    if (!link && !preview) return "";
    if (!link) return `- ${preview}`;
    return `- ${link}${preview ? ` — ${preview}` : ""}`;
  }).filter(Boolean);
  const body = [
    `What changed on "${topic}" in the last day, from the public graph (claimant posts, not a verdict).`,
    "",
    ...lines,
    "",
    `My read: ${posts.length} indexed post${posts.length === 1 ? "" : "s"} since the cutoff. Truncation and missing posts are possible.`,
  ].join("\n");
  return finishDraft({
    format: "what_changed",
    title: `What changed: ${topic}`,
    body,
    uris,
    tool_trace: [{ tool: "get_what_changed", topic, since, posts: posts.length }],
  });
}
