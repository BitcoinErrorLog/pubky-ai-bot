import type { Config } from "../config.js";
import { defaultManifestPath } from "../knowledge/run-ingest.js";
import { GIT_SOURCE_URL } from "../knowledge/ingest.js";
import { KnowledgeStore } from "../knowledge/store.js";
import type { Store } from "../db.js";
import { composeDraftProse, type DraftCompleteFn } from "./compose.js";
import { isPubkyEcosystemRepo, isPubkyEcosystemSlug, parseGithubRepo } from "./ecosystem.js";
import { filterEvidenceUris } from "./evidence-uri.js";
import { DraftRejectedError, finishDraft, sanitizeUntrustedDraftText } from "./finish.js";
import { fetchGithubCommitsSince, GithubUnavailableError } from "./github.js";
import {
  fetchGithubReleases,
  gitRepoFromLocation,
  gitSourcesFromManifest,
  type IndexedGitRelease,
} from "./release-radar.js";
import type { Draft } from "./types.js";
import { draftWindow, DEFAULT_WINDOW_DAYS } from "./window.js";

export interface KnowledgeChange {
  source_id: string;
  path: string;
  source_url: string | null;
  ingested_at: string;
  product: string;
  status: string;
}

export async function generateWhatChanged(opts: {
  appUrl?: string;
  cfg?: Config;
  store?: Store;
  complete?: DraftCompleteFn;
  windowDays?: number;
  nowMs?: number;
  timeoutMs?: number;
  manifestPath?: string;
  listKnowledgeChanges?: () => Promise<KnowledgeChange[]>;
  listCommits?: () => Promise<Array<{ repo: string; html_url: string; message: string; date: string | null }>>;
  listReleases?: () => Promise<IndexedGitRelease[]>;
}): Promise<Draft> {
  const window = draftWindow(opts.nowMs ?? Date.now(), opts.windowDays ?? DEFAULT_WINDOW_DAYS);
  const timeoutMs = opts.timeoutMs ?? opts.cfg?.nexusTimeoutMs ?? 10_000;
  const since = new Date(window.sinceMs);

  const knowledge =
    opts.listKnowledgeChanges ??
    (async () => {
      if (!opts.store) return [];
      const kn = new KnowledgeStore(opts.store.pool);
      const rows = await kn.listDocumentsIngestedSince(since, 40);
      return rows.map((r) => ({
        source_id: r.source_id,
        path: r.path,
        source_url: r.source_url,
        ingested_at: r.ingested_at.toISOString(),
        product: r.product,
        status: r.status,
      }));
    });

  const docs = await knowledge();
  const commits =
    opts.listCommits ??
    (async () => {
      const sources = gitSourcesFromManifest(opts.manifestPath ?? defaultManifestPath()).filter((s) =>
        GIT_SOURCE_URL.test(s.location.replace(/\.git$/, "")),
      );
      const acc: Array<{ repo: string; html_url: string; message: string; date: string | null }> = [];
      for (const s of sources) {
        const parsed = parseGithubRepo(s.location) ?? gitRepoFromLocation(s.location.replace(/\.git$/, ""));
        if (!parsed || !isPubkyEcosystemRepo(parsed.owner, parsed.repo)) continue;
        acc.push(...(await fetchGithubCommitsSince(parsed.owner, parsed.repo, since.toISOString(), timeoutMs)));
      }
      return acc;
    });
  const releases =
    opts.listReleases ??
    (async () => {
      const sources = gitSourcesFromManifest(opts.manifestPath ?? defaultManifestPath());
      const acc: IndexedGitRelease[] = [];
      for (const s of sources) {
        const parsed = gitRepoFromLocation(s.location.replace(/\.git$/, ""));
        if (!parsed || !isPubkyEcosystemRepo(parsed.owner, parsed.repo)) continue;
        acc.push(...(await fetchGithubReleases(parsed.owner, parsed.repo, timeoutMs)));
      }
      return acc;
    });

  let commitRows: Array<{ repo: string; html_url: string; message: string; date: string | null }>;
  let allRel: IndexedGitRelease[];
  try {
    commitRows = (docs.length > 0 && !opts.listCommits ? [] : await commits()).filter((c) =>
      isPubkyEcosystemSlug(c.repo),
    );
    allRel = (await releases()).filter((r) => isPubkyEcosystemSlug(r.repo));
  } catch (e) {
    if (e instanceof GithubUnavailableError) {
      throw new DraftRejectedError("what_changed", "none: evidence source unavailable");
    }
    throw e;
  }
  const recentRel = allRel.filter((r) => {
    if (!r.published_at) return false;
    const t = Date.parse(r.published_at);
    return Number.isFinite(t) && t >= window.sinceMs && t <= window.untilMs;
  });

  const uris = filterEvidenceUris([
    ...docs.map((d) => d.source_url).filter((u): u is string => Boolean(u)),
    ...commitRows.map((c) => c.html_url),
    ...recentRel.map((r) => r.html_url),
  ]);
  if (uris.length === 0) {
    throw new DraftRejectedError("what_changed", "none: nothing changed in the knowledge index or Pubky releases");
  }

  const notes = [
    docs.length
      ? `Knowledge documents ingested in window:\n${docs
          .slice(0, 12)
          .map((d) => `- ${d.source_url ?? d.path} (${sanitizeUntrustedDraftText(`${d.product}, ${d.status}`)})`)
          .join("\n")}`
      : "No knowledge_documents rows in the window.",
    commitRows.length
      ? `GitHub commits:\n${commitRows
          .slice(0, 12)
          .map((c) => `- ${c.repo}: ${sanitizeUntrustedDraftText(c.message)} ${c.html_url}`)
          .join("\n")}`
      : "",
    recentRel.length
      ? `Pubky-ecosystem releases:\n${recentRel.map((r) => `- ${r.repo} ${sanitizeUntrustedDraftText(r.tag_name)} ${r.html_url}`).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const body = await composeDraftProse({
    format: "what_changed",
    cfg: opts.cfg,
    complete: opts.complete,
    noneFallback: "nothing material changed",
    evidenceNotes: notes,
    instruction: [
      "Write 3–6 bullets of the form 'X changed: what it means', each with a link from Evidence.",
      "Skip noise (chore bumps, lockfile-only). Interpretations are your read.",
      "If nothing material changed, reply none.",
    ].join(" "),
  });
  return finishDraft({
    format: "what_changed",
    title: "What changed",
    body,
    uris,
    appUrl: opts.appUrl,
    tool_trace: [
      { tool: "knowledge_documents", window, docs: docs.length, commits: commitRows.length, releases: recentRel.length },
    ],
  });
}
