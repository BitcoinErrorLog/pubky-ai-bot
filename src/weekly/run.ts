import type { Config } from "../config.js";
import type { Store } from "../db.js";
import { log } from "../log.js";
import type { Nexus } from "../nexus.js";
import { createScoutTools } from "../scout/tools.js";
import { ScoutClient } from "../scout/client.js";
import { buildFeedbackArticle } from "./feedback-article.js";
import { gatherProjectCandidates, type CandidatePost } from "./gather.js";
import { learnCandidateProjects } from "./learn.js";
import { enqueueWeeklyArticle } from "./publish-article.js";
import { claimWeeklySlot, finishWeeklySlot, listTrackedProjectsSafe, weeklyTokensUsed } from "./store.js";
import { collectTaggedFeedback } from "./tag-collect.js";
import { renderUpdatesArticle, writeProjectSection } from "./updates-article.js";
import type { FeedbackItem, TrackedProject, WeeklySeries } from "./types.js";
import { isoWeekKey, mondayOfIsoWeek } from "./week-key.js";

export async function runFeedbackSeries(opts: {
  cfg: Config;
  store: Store;
  nexus: Nexus;
  weekKey: string;
  dryRun: boolean;
  now?: Date;
}): Promise<{ markdown: string; published: boolean; skipped: boolean }> {
  let extra: FeedbackItem[] = [];
  try {
    const collected = await collectTaggedFeedback({
      cfg: opts.cfg,
      store: opts.store,
      nexus: opts.nexus,
      now: opts.now,
      persist: !opts.dryRun,
    });
    if (opts.dryRun) extra = collected.items;
  } catch (e) {
    log.warn({ err: String(e) }, "weekly feedback: tag collect failed; using stored rows");
  }
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - 7 * 86_400_000);
  const article = await buildFeedbackArticle(opts.store.pool, {
    weekKey: opts.weekKey,
    since,
    appUrl: opts.cfg.appUrl,
    extra,
  });
  if (!article) {
    log.info({ week: opts.weekKey }, "weekly feedback: zero items; not publishing");
    if (!opts.dryRun) {
      const claimed = await claimWeeklySlot(opts.store.pool, "feedback", opts.weekKey);
      if (claimed) await finishWeeklySlot(opts.store.pool, "feedback", opts.weekKey, { status: "skipped" });
    }
    return { markdown: "", published: false, skipped: true };
  }
  const out = await enqueueWeeklyArticle(opts.store, opts.cfg, {
    series: "feedback",
    weekKey: opts.weekKey,
    article: { title: article.title, body: article.body, tags: ["community-feedback"], feedbackIds: article.itemIds },
    dryRun: opts.dryRun,
  });
  return { markdown: out.markdown, published: out.inserted, skipped: false };
}

async function keywordSearch(
  cfg: Config,
  store: Store,
  weekKey: string,
): Promise<((query: string) => Promise<Array<{ uri: string; author: string; content: string; indexedAt: number }>>) | undefined> {
  if (await store.switchOn("scout")) return undefined;
  const scout = createScoutTools({
    cfg,
    pool: store.pool,
    mentionKey: `weekly:updates:${weekKey}`,
    storeSwitchOn: () => store.switchOn("scout"),
    client: new ScoutClient(cfg, store.pool),
  });
  const since = mondayOfIsoWeek(weekKey).getTime();
  const until = since + 7 * 86_400_000;
  return async (query: string) => {
    const out = await scout.search_posts.execute({ query, time_range: { since, until }, limit: 15 });
    if (!out || typeof out !== "object" || !("posts" in out) || !Array.isArray((out as { posts: unknown }).posts)) {
      return [];
    }
    return (out as { posts: Array<{ uri?: string; author_id?: string; content_preview?: string; indexed_at?: number }> }).posts
      .filter((p) => typeof p.uri === "string" && typeof p.author_id === "string")
      .map((p) => ({
        uri: p.uri as string,
        author: p.author_id as string,
        content: String(p.content_preview ?? ""),
        indexedAt: Number(p.indexed_at ?? 0),
      }));
  };
}

export async function runUpdatesSeries(opts: {
  cfg: Config;
  store: Store;
  nexus: Nexus;
  weekKey: string;
  dryRun: boolean;
  now?: Date;
}): Promise<{ markdown: string; published: boolean; skipped: boolean }> {
  const projects = await listTrackedProjectsSafe(opts.store.pool);
  const sinceMs = mondayOfIsoWeek(opts.weekKey).getTime();
  const untilMs = sinceMs + 7 * 86_400_000;
  const search = await keywordSearch(opts.cfg, opts.store, opts.weekKey);
  const candidates = await gatherProjectCandidates({
    cfg: opts.cfg,
    nexus: opts.nexus,
    projects,
    sinceMs,
    untilMs,
    botPk: opts.cfg.botPk,
    searchKeyword: search,
  });
  const newcomers = await learnCandidateProjects(opts.store.pool, candidates, projects, {
    persist: !opts.dryRun,
  });
  const active = projects.filter((p) => p.status === "active");
  const sections: Array<{ project: TrackedProject; markdown: string }> = [];
  const quiet: TrackedProject[] = [];
  let tokens = 0;
  for (const project of active) {
    const posts = candidates.filter((c) => c.projectIds.includes(project.id)).slice(0, 8);
    if (posts.length === 0) {
      quiet.push(project);
      continue;
    }
    if (tokens >= opts.cfg.weeklyTokenCap) {
      quiet.push(project);
      continue;
    }
    const spent = await storeTokensGuard(opts.store, opts.cfg, `weekly:updates:${opts.weekKey}`, opts.cfg.weeklyTokenCap);
    if (!spent.ok) {
      quiet.push(project);
      continue;
    }
    let section: { markdown: string; tokens: number };
    try {
      section = await writeProjectSection(opts.cfg, project, posts);
    } catch (e) {
      log.warn({ err: String(e), project: project.id }, "weekly updates: section failed");
      quiet.push(project);
      continue;
    }
    tokens += section.tokens;
    if (section.tokens > 0) {
      await opts.store.recordUsage({
        mentionKey: `weekly:updates:${opts.weekKey}`,
        publicKey: opts.cfg.botPk ?? "weekly",
        phase: "weekly",
        model: opts.cfg.model,
        totalTokens: section.tokens,
      });
    }
    if (section.markdown) sections.push({ project, markdown: section.markdown });
    else quiet.push(project);
  }
  if (sections.length === 0 && newcomers.length === 0) {
    log.info({ week: opts.weekKey }, "weekly updates: nothing to publish");
    if (!opts.dryRun) {
      const claimed = await claimWeeklySlot(opts.store.pool, "updates", opts.weekKey);
      if (claimed) await finishWeeklySlot(opts.store.pool, "updates", opts.weekKey, { status: "skipped" });
    }
    return { markdown: "", published: false, skipped: true };
  }
  const article = renderUpdatesArticle({ weekKey: opts.weekKey, sections, quiet, newcomers });
  const out = await enqueueWeeklyArticle(opts.store, opts.cfg, {
    series: "updates",
    weekKey: opts.weekKey,
    article: { title: article.title, body: article.body, tags: article.tags },
    dryRun: opts.dryRun,
  });
  return { markdown: out.markdown, published: out.inserted, skipped: false };
}

async function storeTokensGuard(
  store: Store,
  cfg: Config,
  mentionKey: string,
  cap: number,
): Promise<{ ok: boolean }> {
  const global = await store.globalDailyTokens();
  if (global + 8_000 > cfg.dailyTokenBudget) return { ok: false };
  const used = await weeklyTokensUsed(store.pool, mentionKey);
  if (used >= cap) return { ok: false };
  return { ok: true };
}

export async function runWeeklySeries(opts: {
  cfg: Config;
  store: Store;
  nexus: Nexus;
  series: WeeklySeries;
  weekKey?: string;
  dryRun: boolean;
  now?: Date;
}): Promise<{ markdown: string; published: boolean; skipped: boolean }> {
  const now = opts.now ?? new Date();
  const weekKey = opts.weekKey ?? (opts.series === "updates" ? isoWeekKey(new Date(now.getTime() - 7 * 86_400_000), opts.cfg.weeklyTz) : isoWeekKey(now, opts.cfg.weeklyTz));
  if (opts.series === "feedback") return runFeedbackSeries({ ...opts, weekKey, now });
  return runUpdatesSeries({ ...opts, weekKey, now });
}

export type { CandidatePost };
