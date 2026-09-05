import type { Config } from "../config.js";
import type { Store } from "../db.js";
import { log } from "../log.js";
import type { Nexus } from "../nexus.js";
import { createScoutTools } from "../scout/tools.js";
import { ScoutClient } from "../scout/client.js";
import { classifyJebMentions, emptyClassifierCounts, type ClassifierKindCounts } from "./classify-mentions.js";
import { buildFeedbackArticle, sundayFeedbackUris } from "./feedback-article.js";
import { gatherProjectCandidates, type CandidatePost } from "./gather.js";
import { learnCandidateProjects } from "./learn.js";
import { enqueueWeeklyArticle } from "./publish-article.js";
import { claimWeeklySlot, finishWeeklySlot, listTrackedProjectsSafe, listUnincludedFeedbackSinceSafe, weeklyTokensUsed } from "./store.js";
import { collectTaggedFeedback } from "./tag-collect.js";
import { renderUpdatesArticle, writeProjectSection } from "./updates-article.js";
import type { FeedbackItem, TrackedProject, WeeklySeries } from "./types.js";
import { feedbackWindow, nextIssueWeekKey, updatesWindow, type WeekWindow } from "./week-key.js";

export interface WeeklyRunResult {
  markdown: string;
  published: boolean;
  skipped: boolean;
  weekKey: string;
  window: WeekWindow;
  classifierCounts?: ClassifierKindCounts;
}

function windowComment(series: WeeklySeries, weekKey: string, win: WeekWindow): string {
  return `<!-- weekly series=${series} week=${weekKey} since=${new Date(win.sinceMs).toISOString()} until=${new Date(win.untilMs).toISOString()} -->`;
}

export async function runFeedbackSeries(opts: {
  cfg: Config;
  store: Store;
  nexus: Nexus;
  weekKey: string;
  dryRun: boolean;
  now?: Date;
}): Promise<WeeklyRunResult> {
  const win = feedbackWindow(opts.weekKey, opts.cfg.weeklyTz);
  let extra: FeedbackItem[] = [];
  try {
    const collected = await collectTaggedFeedback({
      cfg: opts.cfg,
      store: opts.store,
      nexus: opts.nexus,
      now: opts.now,
      persist: !opts.dryRun,
      sinceMs: win.sinceMs,
      untilMs: win.untilMs,
    });
    extra = collected.items;
  } catch (e) {
    log.warn({ err: String(e) }, "weekly feedback: tag collect failed; using stored rows");
  }
  let classifierCounts = emptyClassifierCounts();
  try {
    const classified = await classifyJebMentions({
      cfg: opts.cfg,
      store: opts.store,
      nexus: opts.nexus,
      sinceMs: win.sinceMs,
      untilMs: win.untilMs,
      persist: !opts.dryRun,
      now: opts.now,
    });
    classifierCounts = classified.counts;
    extra = [...extra, ...classified.items];
  } catch (e) {
    log.warn({ err: String(e) }, "weekly feedback: mention classify failed");
  }
  const article = await buildFeedbackArticle(opts.store.pool, {
    weekKey: opts.weekKey,
    since: new Date(win.sinceMs),
    until: new Date(win.untilMs),
    appUrl: opts.cfg.appUrl,
    extra,
    botPk: opts.cfg.botPk,
  });
  if (!article) {
    log.info({ week: opts.weekKey }, "weekly feedback: zero items; not publishing");
    if (!opts.dryRun) {
      const claimed = await claimWeeklySlot(opts.store.pool, "feedback", opts.weekKey);
      if (claimed) await finishWeeklySlot(opts.store.pool, "feedback", opts.weekKey, { status: "skipped" });
    }
    return {
      markdown: "",
      published: false,
      skipped: true,
      weekKey: opts.weekKey,
      window: win,
      classifierCounts,
    };
  }
  const out = await enqueueWeeklyArticle(opts.store, opts.cfg, {
    series: "feedback",
    weekKey: opts.weekKey,
    article: { title: article.title, body: article.body, tags: ["community-feedback"], feedbackIds: article.itemIds },
    dryRun: opts.dryRun,
  });
  return {
    markdown: `${out.markdown}\n${windowComment("feedback", opts.weekKey, win)}\n`,
    published: out.inserted,
    skipped: false,
    weekKey: opts.weekKey,
    window: win,
    classifierCounts,
  };
}

async function keywordSearch(
  cfg: Config,
  store: Store,
  weekKey: string,
  sinceMs: number,
  untilMs: number,
): Promise<((query: string) => Promise<Array<{ uri: string }>>) | undefined> {
  if (await store.switchOn("scout")) return undefined;
  const scout = createScoutTools({
    cfg,
    pool: store.pool,
    mentionKey: `weekly:updates:${weekKey}`,
    storeSwitchOn: () => store.switchOn("scout"),
    client: new ScoutClient(cfg, store.pool),
  });
  return async (query: string) => {
    const out = await scout.search_posts.execute({ query, time_range: { since: sinceMs, until: untilMs }, limit: 15 });
    if (!out || typeof out !== "object" || !("posts" in out) || !Array.isArray((out as { posts: unknown }).posts)) {
      return [];
    }
    return (out as { posts: Array<{ uri?: string }> }).posts
      .filter((p) => typeof p.uri === "string")
      .map((p) => ({ uri: p.uri as string }));
  };
}

async function mentionsSearch(
  cfg: Config,
  store: Store,
  weekKey: string,
  sinceMs: number,
  untilMs: number,
): Promise<((pubky: string) => Promise<Array<{ uri: string }>>) | undefined> {
  if (await store.switchOn("scout")) return undefined;
  const scout = createScoutTools({
    cfg,
    pool: store.pool,
    mentionKey: `weekly:updates:${weekKey}`,
    storeSwitchOn: () => store.switchOn("scout"),
    client: new ScoutClient(cfg, store.pool),
  });
  return async (pubky: string) => {
    const out = await scout.mentions_of.execute({ pubky, time_range: { since: sinceMs, until: untilMs }, limit: 25 });
    if (!out || typeof out !== "object" || !("posts" in out) || !Array.isArray((out as { posts: unknown }).posts)) {
      return [];
    }
    return (out as { posts: Array<{ uri?: string }> }).posts
      .filter((p) => typeof p.uri === "string")
      .map((p) => ({ uri: p.uri as string }));
  };
}

export async function runUpdatesSeries(opts: {
  cfg: Config;
  store: Store;
  nexus: Nexus;
  weekKey: string;
  dryRun: boolean;
  now?: Date;
}): Promise<WeeklyRunResult> {
  const win = updatesWindow(opts.weekKey, opts.cfg.weeklyTz);
  const projects = await listTrackedProjectsSafe(opts.store.pool);
  const search = await keywordSearch(opts.cfg, opts.store, opts.weekKey, win.sinceMs, win.untilMs);
  const mentionsOf = await mentionsSearch(opts.cfg, opts.store, opts.weekKey, win.sinceMs, win.untilMs);
  const candidates = await gatherProjectCandidates({
    cfg: opts.cfg,
    nexus: opts.nexus,
    projects,
    sinceMs: win.sinceMs,
    untilMs: win.untilMs,
    botPk: opts.cfg.botPk,
    searchKeyword: search,
    mentionsOf,
  });
  const newcomers = await learnCandidateProjects(opts.store.pool, candidates, projects, {
    persist: !opts.dryRun,
  });
  const sundayUris = new Set<string>();
  try {
    const stored = await listUnincludedFeedbackSinceSafe(
      opts.store.pool,
      new Date(win.sinceMs),
      new Date(win.untilMs),
    );
    for (const uri of sundayFeedbackUris(stored)) sundayUris.add(uri);
  } catch (e) {
    log.warn({ err: String(e) }, "weekly updates: stored feedback lookup failed");
  }
  try {
    const classified = await classifyJebMentions({
      cfg: opts.cfg,
      store: opts.store,
      nexus: opts.nexus,
      sinceMs: win.sinceMs,
      untilMs: win.untilMs,
      persist: !opts.dryRun,
      now: opts.now,
    });
    for (const uri of sundayFeedbackUris(classified.items)) sundayUris.add(uri);
  } catch (e) {
    log.warn({ err: String(e) }, "weekly updates: mention classify for Jeb section failed");
  }
  const active = projects.filter((p) => p.status === "active");
  const sections: Array<{ project: TrackedProject; markdown: string }> = [];
  const quiet: TrackedProject[] = [];
  let tokens = 0;
  for (const project of active) {
    let posts = candidates.filter((c) => c.projectIds.includes(project.id));
    if (project.id === "jeb") posts = posts.filter((p) => !sundayUris.has(p.uri));
    posts = posts.slice(0, 8);
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
    return { markdown: "", published: false, skipped: true, weekKey: opts.weekKey, window: win };
  }
  const article = renderUpdatesArticle({ weekKey: opts.weekKey, sections, quiet, newcomers });
  const out = await enqueueWeeklyArticle(opts.store, opts.cfg, {
    series: "updates",
    weekKey: opts.weekKey,
    article: { title: article.title, body: article.body, tags: article.tags },
    dryRun: opts.dryRun,
  });
  return {
    markdown: `${out.markdown}\n${windowComment("updates", opts.weekKey, win)}\n`,
    published: out.inserted,
    skipped: false,
    weekKey: opts.weekKey,
    window: win,
  };
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
}): Promise<WeeklyRunResult> {
  const now = opts.now ?? new Date();
  const weekKey = opts.weekKey ?? nextIssueWeekKey(opts.series, now, opts.cfg.weeklyTz);
  if (opts.series === "feedback") return runFeedbackSeries({ ...opts, weekKey, now });
  return runUpdatesSeries({ ...opts, weekKey, now });
}

export type { CandidatePost };
