import type { Config } from "../config.js";
import type { Nexus } from "../nexus.js";
import { composeDraftProse, type DraftCompleteFn } from "./compose.js";
import { DraftRejectedError, finishDraft, isToolError } from "./finish.js";
import { asPosts } from "./scout-util.js";
import type { ScoutTools } from "./scout-util.js";
import {
  candidateUri,
  fetchFullThread,
  formatThreadForPrompt,
  scoreThread,
  threadEvidenceUris,
  type ScoredThread,
} from "./thread.js";
import type { Draft } from "./types.js";
import { draftWindow, filterWindowPosts, DEFAULT_WINDOW_DAYS } from "./window.js";

function hasOpposingAuthors(thread: ScoredThread): boolean {
  const authors = new Set(thread.posts.map((p) => p.author_id));
  if (authors.size < 2) return false;
  const replies = thread.posts.filter((p) => p.parent_uri);
  const replyAuthors = new Set(replies.map((p) => p.author_id));
  return replyAuthors.size >= 1 && authors.size >= 2;
}

export async function generateTheDisagreement(opts: {
  scout: ScoutTools;
  appUrl: string;
  cfg?: Config;
  nexus?: Nexus;
  complete?: DraftCompleteFn;
  windowDays?: number;
  nowMs?: number;
  botPk?: string;
  fetchThread?: (uri: string) => Promise<import("./thread.js").ThreadPost[]>;
}): Promise<Draft> {
  const window = draftWindow(opts.nowMs ?? Date.now(), opts.windowDays ?? DEFAULT_WINDOW_DAYS);
  const time_range = { since: window.sinceMs, until: window.untilMs };
  const raw = await opts.scout.top_posts.execute({ metric: "replies", limit: 20, time_range });
  if (isToolError(raw)) throw new DraftRejectedError("the_disagreement", "scout unavailable");
  const seeds = filterWindowPosts(asPosts(raw), { window, botPk: opts.botPk }).filter((p) => candidateUri(p));
  const load = opts.fetchThread ?? (opts.nexus ? (uri: string) => fetchFullThread(opts.nexus!, uri) : undefined);
  if (!load) throw new DraftRejectedError("the_disagreement", "nexus unavailable");

  const debates: ScoredThread[] = [];
  for (const seed of seeds.slice(0, 12)) {
    const uri = candidateUri(seed);
    if (!uri) continue;
    try {
      const posts = await load(uri);
      const thread = scoreThread(posts, window, opts.botPk);
      if (thread && hasOpposingAuthors(thread)) debates.push(thread);
    } catch {
      /* skip */
    }
  }
  debates.sort((a, b) => b.score - a.score);
  const top = debates.slice(0, 6);
  if (top.length === 0) {
    throw new DraftRejectedError("the_disagreement", "none: no reply-chain disagreement in the window");
  }

  const notes = top
    .map((t, i) => `Thread ${i + 1}:\n${formatThreadForPrompt(t, opts.appUrl)}`)
    .join("\n\n");
  const body = await composeDraftProse({
    format: "the_disagreement",
    cfg: opts.cfg,
    complete: opts.complete,
    noneFallback: "no real disagreement",
    evidenceNotes: notes,
    instruction: [
      "Find a thread where at least two distinct authors reply to each other with opposing claims.",
      "Tag-label clusters are not a disagreement. If none of the threads contain a real disagreement, reply none.",
      "Write: the topic; side A (who, their claim, a link); side B (who, their claim, a link); what evidence each cites; then one line — Jeb's note — of what would settle it.",
      "No verdict. No winner.",
    ].join(" "),
  });
  return finishDraft({
    format: "the_disagreement",
    title: "The disagreement",
    body,
    uris: [...new Set(top.flatMap(threadEvidenceUris))],
    appUrl: opts.appUrl,
    tool_trace: [{ tool: "top_posts", metric: "replies", window, debates: debates.length }],
  });
}
