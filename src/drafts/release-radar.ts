import { fetchJson } from "../http.js";
import { loadManifest } from "../knowledge/manifest.js";
import { defaultManifestPath } from "../knowledge/run-ingest.js";
import { GIT_SOURCE_URL } from "../knowledge/ingest.js";
import type { SourceEntry } from "../knowledge/types.js";
import { DraftRejectedError, finishDraft } from "./finish.js";
import type { Draft } from "./types.js";

export interface IndexedGitRelease {
  repo: string;
  html_url: string;
  name: string;
  published_at: string | null;
  tag_name: string;
}

export function gitRepoFromLocation(location: string): { owner: string; repo: string } | null {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)$/.exec(location.replace(/\.git$/, ""));
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

export function gitSourcesFromManifest(manifestPath = defaultManifestPath()): SourceEntry[] {
  const manifest = loadManifest(manifestPath);
  return manifest.sources.filter((s) => s.enabled !== false && s.kind === "git" && GIT_SOURCE_URL.test(s.location.replace(/\.git$/, "")));
}

export async function fetchGithubReleases(
  owner: string,
  repo: string,
  timeoutMs: number,
): Promise<IndexedGitRelease[]> {
  const url = new URL(`https://api.github.com/repos/${owner}/${repo}/releases`);
  url.searchParams.set("per_page", "5");
  const { status, body } = await fetchJson(url, timeoutMs, {
    Accept: "application/vnd.github+json",
    "User-Agent": "jeb-drafts",
  });
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
    });
  }
  return out;
}

export async function fetchGithubTags(
  owner: string,
  repo: string,
  timeoutMs: number,
): Promise<IndexedGitRelease[]> {
  const url = new URL(`https://api.github.com/repos/${owner}/${repo}/tags`);
  url.searchParams.set("per_page", "5");
  const { status, body } = await fetchJson(url, timeoutMs, {
    Accept: "application/vnd.github+json",
    "User-Agent": "jeb-drafts",
  });
  if (status !== 200 || !Array.isArray(body)) return [];
  const out: IndexedGitRelease[] = [];
  for (const item of body) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name : "";
    if (!name) continue;
    out.push({
      repo: `${owner}/${repo}`,
      html_url: `https://github.com/${owner}/${repo}/releases/tag/${encodeURIComponent(name)}`,
      name,
      published_at: null,
      tag_name: name,
    });
  }
  return out;
}

const WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export async function generateReleaseRadar(opts: {
  listReleases?: () => Promise<IndexedGitRelease[]>;
  nowMs?: number;
  timeoutMs?: number;
  manifestPath?: string;
}): Promise<Draft> {
  const now = opts.nowMs ?? Date.now();
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const list =
    opts.listReleases ??
    (async () => {
      const sources = gitSourcesFromManifest(opts.manifestPath);
      const acc: IndexedGitRelease[] = [];
      for (const s of sources) {
        const parsed = gitRepoFromLocation(s.location.replace(/\.git$/, ""));
        if (!parsed) continue;
        const rels = await fetchGithubReleases(parsed.owner, parsed.repo, timeoutMs);
        if (rels.length > 0) acc.push(...rels);
        else acc.push(...(await fetchGithubTags(parsed.owner, parsed.repo, timeoutMs)));
      }
      return acc;
    });
  const all = await list();
  const recent = all.filter((r) => {
    if (!r.published_at) return false;
    const t = Date.parse(r.published_at);
    return Number.isFinite(t) && now - t <= WINDOW_MS;
  });
  const evidence = (recent.length > 0 ? recent : all).map((r) => r.html_url).filter(Boolean);
  const fallback = gitSourcesFromManifest(opts.manifestPath)
    .slice(0, 3)
    .map((s) => `${s.location}/releases`);
  const uris = evidence.length > 0 ? evidence : fallback;
  if (uris.length === 0) throw new DraftRejectedError("release_radar", "no evidence URI");
  let body: string;
  if (recent.length === 0) {
    body = [
      "Release radar: no dated GitHub releases in the last 14 days among indexed git sources (see docs/knowledge.md).",
      "I am not inventing a changelog. Tags without a release date are omitted from the 'new' list.",
      `Indexed git sources checked: ${gitSourcesFromManifest(opts.manifestPath).length}.`,
      `Sample: ${uris.slice(0, 3).join(" ")}`,
    ].join("\n");
  } else {
    const lines = recent.slice(0, 8).map((r) => `- ${r.repo} ${r.tag_name} (${r.published_at ?? "undated"}) ${r.html_url}`);
    body = [
      "Release radar from GitHub releases on knowledge-index git repos. Dates are GitHub's published_at, not Jeb's inference.",
      "",
      ...lines,
    ].join("\n");
  }
  return finishDraft({
    format: "release_radar",
    title: "Release radar",
    body,
    uris,
    tool_trace: [{ tool: "github_releases", recent: recent.length, fetched: all.length }],
  });
}
