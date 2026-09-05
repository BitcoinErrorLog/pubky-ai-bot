import type { Config } from "../config.js";
import type { Nexus } from "../nexus.js";
import { composeDraftProse, type DraftCompleteFn } from "./compose.js";
import { DraftRejectedError, finishDraft, isToolError } from "./finish.js";
import { asPosts, postLink } from "./scout-util.js";
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

const TOP_N = 8;

export async function generateThreadWorthReading(opts: {
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
  if (isToolError(raw)) throw new DraftRejectedError("thread_worth_reading", "scout unavailable");
  const seeds = filterWindowPosts(asPosts(raw), { window, botPk: opts.botPk }).filter((p) => candidateUri(p));
  if (seeds.length === 0) {
    throw new DraftRejectedError("thread_worth_reading", "none: no posts in the 7-day window");
  }

  const load = opts.fetchThread ?? (opts.nexus ? (uri: string) => fetchFullThread(opts.nexus!, uri) : undefined);
  if (!load) throw new DraftRejectedError("thread_worth_reading", "nexus unavailable");

  const scored: ScoredThread[] = [];
  for (const seed of seeds.slice(0, 12)) {
    const uri = candidateUri(seed);
    if (!uri) continue;
    try {
      const posts = await load(uri);
      const thread = scoreThread(posts, window, opts.botPk);
      if (thread && thread.distinctAuthors >= 2 && thread.replies >= 1) scored.push(thread);
    } catch {
      /* skip a seed that failed to hydrate */
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, TOP_N);
  if (top.length === 0) {
    throw new DraftRejectedError("thread_worth_reading", "none: no multi-author threads in the window");
  }

  const evidenceUris = [...new Set(top.flatMap(threadEvidenceUris))];
  const notes = top
    .map((t, i) => `Candidate ${i + 1} (score ${t.score}):\n${formatThreadForPrompt(t, opts.appUrl)}`)
    .join("\n\n");
  const body = await composeDraftProse({
    format: "thread_worth_reading",
    cfg: opts.cfg,
    complete: opts.complete,
    noneFallback: "no substantive thread",
    evidenceNotes: notes,
    instruction: [
      "Pick the ONE thread with the most substantive discussion (not the busiest, not jokes, not 'how old are you').",
      "Write: one paragraph on what the thread is about; then 2–4 bullets of the actual positions/points, each with an author profile or post link from Evidence; then one line on why it is worth reading.",
      "Link the root post. Mark interpretations as your read. No verdict.",
    ].join(" "),
  });
  const citedRoot = top.find((t) => body.includes(postLink(t.root.uri, opts.appUrl)) || body.includes(t.root.uri));
  const uris = citedRoot ? threadEvidenceUris(citedRoot) : evidenceUris;
  return finishDraft({
    format: "thread_worth_reading",
    title: "The thread worth reading",
    body,
    uris,
    appUrl: opts.appUrl,
    tool_trace: [
      { tool: "top_posts", metric: "replies", window, seeds: seeds.length, scored: scored.length },
    ],
  });
}
