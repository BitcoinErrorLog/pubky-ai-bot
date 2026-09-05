import { fetchJson } from "../http.js";
import { loadManifest } from "../knowledge/manifest.js";
import { defaultManifestPath } from "../knowledge/run-ingest.js";
import { GIT_SOURCE_URL } from "../knowledge/ingest.js";
import type { Config } from "../config.js";
import type { SourceEntry } from "../knowledge/types.js";
import { composeDraftProse, type DraftCompleteFn } from "./compose.js";
import { isPubkyEcosystemRepo, isPubkyEcosystemSlug } from "./ecosystem.js";
import { DraftRejectedError, finishDraft } from "./finish.js";
import { fetchGithubReleaseBody, type IndexedGitRelease } from "./github.js";
import type { Draft } from "./types.js";
import { draftWindow, DEFAULT_WINDOW_DAYS } from "./window.js";

export type { IndexedGitRelease } from "./github.js";

export function gitRepoFromLocation(location: string): { owner: string; repo: string } | null {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)$/.exec(location.replace(/\.git$/, ""));
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

export function gitSourcesFromManifest(manifestPath = defaultManifestPath()): SourceEntry[] {
  const manifest = loadManifest(manifestPath);
  return manifest.sources.filter(
    (s) => s.enabled !== false && s.kind === "git" && GIT_SOURCE_URL.test(s.location.replace(/\.git$/, "")),
  );
}

export function pubkyGitSourcesFromManifest(manifestPath = defaultManifestPath()): SourceEntry[] {
  return gitSourcesFromManifest(manifestPath).filter((s) => {
    const parsed = gitRepoFromLocation(s.location.replace(/\.git$/, ""));
    return parsed ? isPubkyEcosystemRepo(parsed.owner, parsed.repo) : false;
  });
}

export async function fetchGithubReleases(
  owner: string,
  repo: string,
  timeoutMs: number,
): Promise<IndexedGitRelease[]> {
  const url = new URL(`https://api.github.com/repos/${owner}/${repo}/releases`);
  url.searchParams.set("per_page", "5");
  let status: number;
  let body: unknown;
  try {
    const res = await fetchJson(url, timeoutMs, {
      Accept: "application/vnd.github+json",
      "User-Agent": "jeb-drafts",
    });
    status = res.status;
    body = res.body;
  } catch {
    return [];
  }
  if (status !== 200 || !Array.isArray(body)) return [];
  const out: IndexedGitRelease[] = [];
  for (const item of body) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const html = typeof o.html_url === "string" ? o.html_url : "";
    const tag = typeof o.tag_name === "string" ? o.tag_name : "";
    if (!html || !tag) continue;
    out.push({
      repo: `${owner}/${repo}`,
      html_url: html,
      name: typeof o.name === "string" && o.name ? o.name : tag,
      published_at: typeof o.published_at === "string" ? o.published_at : null,
      tag_name: tag,
      body: typeof o.body === "string" ? o.body : "",
    });
  }
  return out;
}

export async function generateReleaseRadar(opts: {
  listReleases?: () => Promise<IndexedGitRelease[]>;
  nowMs?: number;
  timeoutMs?: number;
  manifestPath?: string;
  windowDays?: number;
  cfg?: Config;
  complete?: DraftCompleteFn;
  fetchBody?: (owner: string, repo: string, tag: string) => Promise<string>;
}): Promise<Draft> {
  const window = draftWindow(opts.nowMs ?? Date.now(), opts.windowDays ?? DEFAULT_WINDOW_DAYS);
  const timeoutMs = opts.timeoutMs ?? opts.cfg?.nexusTimeoutMs ?? 10_000;
  const list =
    opts.listReleases ??
    (async () => {
      const sources = pubkyGitSourcesFromManifest(opts.manifestPath);
      const acc: IndexedGitRelease[] = [];
      for (const s of sources) {
        const parsed = gitRepoFromLocation(s.location.replace(/\.git$/, ""));
        if (!parsed) continue;
        acc.push(...(await fetchGithubReleases(parsed.owner, parsed.repo, timeoutMs)));
      }
      return acc;
    });
  const all = (await list()).filter((r) => isPubkyEcosystemSlug(r.repo));
  const recent = all.filter((r) => {
    if (!r.published_at) return false;
    const t = Date.parse(r.published_at);
    return Number.isFinite(t) && t >= window.sinceMs && t <= window.untilMs;
  });
  if (recent.length === 0) {
    throw new DraftRejectedError("release_radar", "none: no Pubky-ecosystem releases in the window");
  }

  const withBodies: IndexedGitRelease[] = [];
  for (const r of recent) {
    if (r.body && r.body.trim()) {
      withBodies.push(r);
      continue;
    }
    const parsed = gitRepoFromLocation(`https://github.com/${r.repo}`);
    if (!parsed) {
      withBodies.push(r);
      continue;
    }
    const fetchBody = opts.fetchBody ?? ((o, repo, tag) => fetchGithubReleaseBody(o, repo, tag, timeoutMs));
    const body = await fetchBody(parsed.owner, parsed.repo, r.tag_name);
    withBodies.push({ ...r, body });
  }

  const uris = withBodies.map((r) => r.html_url);
  const notes = withBodies
    .map((r) => {
      const excerpt = (r.body ?? "").replace(/\s+/g, " ").slice(0, 400);
      return `${r.repo} ${r.tag_name} (${r.published_at})\n${r.html_url}\n${excerpt || "(no release body)"}`;
    })
    .join("\n\n");

  const body = await composeDraftProse({
    format: "release_radar",
    cfg: opts.cfg,
    complete: opts.complete,
    noneFallback: "no release notes to summarize",
    evidenceNotes: notes,
    instruction: [
      "For each release, write one sentence of what changed, grouped by repo.",
      "Each sentence must include that release's Evidence link. Do not list bitkit or other non-Pubky repos.",
      "If the bodies are empty or off-ecosystem, reply none.",
    ].join(" "),
  });
  return finishDraft({
    format: "release_radar",
    title: "Release radar",
    body,
    uris,
    tool_trace: [{ tool: "github_releases", window, recent: recent.length, fetched: all.length }],
  });
}
