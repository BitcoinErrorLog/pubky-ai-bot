import { fetchJson } from "../http.js";

export interface IndexedGitRelease {
  repo: string;
  html_url: string;
  name: string;
  published_at: string | null;
  tag_name: string;
  body?: string;
}

export interface GithubCommit {
  repo: string;
  sha: string;
  html_url: string;
  message: string;
  date: string | null;
}

const UA = { Accept: "application/vnd.github+json", "User-Agent": "jeb-drafts" };

export async function fetchGithubReleaseBody(
  owner: string,
  repo: string,
  tag: string,
  timeoutMs: number,
): Promise<string> {
  const url = new URL(`https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`);
  try {
    const res = await fetchJson(url, timeoutMs, UA);
    if (res.status !== 200 || !res.body || typeof res.body !== "object") return "";
    const body = (res.body as { body?: unknown }).body;
    return typeof body === "string" ? body : "";
  } catch {
    return "";
  }
}

export async function fetchGithubCommitsSince(
  owner: string,
  repo: string,
  sinceIso: string,
  timeoutMs: number,
): Promise<GithubCommit[]> {
  const url = new URL(`https://api.github.com/repos/${owner}/${repo}/commits`);
  url.searchParams.set("since", sinceIso);
  url.searchParams.set("per_page", "10");
  try {
    const res = await fetchJson(url, timeoutMs, UA);
    if (res.status !== 200 || !Array.isArray(res.body)) return [];
    const out: GithubCommit[] = [];
    for (const item of res.body) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      const sha = typeof o.sha === "string" ? o.sha : "";
      const html = typeof o.html_url === "string" ? o.html_url : "";
      const commit = o.commit && typeof o.commit === "object" ? (o.commit as Record<string, unknown>) : {};
      const message = typeof commit.message === "string" ? commit.message.split("\n")[0] ?? "" : "";
      const author = commit.author && typeof commit.author === "object" ? (commit.author as Record<string, unknown>) : {};
      const date = typeof author.date === "string" ? author.date : null;
      if (!sha || !html) continue;
      out.push({ repo: `${owner}/${repo}`, sha, html_url: html, message: message.slice(0, 200), date });
    }
    return out;
  } catch {
    return [];
  }
}

export function attachReleaseBodies(
  releases: IndexedGitRelease[],
  bodies: Map<string, string>,
): Array<IndexedGitRelease & { body: string }> {
  return releases.map((r) => ({ ...r, body: bodies.get(r.html_url) ?? "" }));
}
