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

export class GithubUnavailableError extends Error {
  constructor() {
    super("evidence source unavailable");
    this.name = "GithubUnavailableError";
  }
}

const UA = { Accept: "application/vnd.github+json", "User-Agent": "jeb-drafts", "Accept-Encoding": "identity" };

async function readCappedText(res: Response, ac: AbortController): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    ac.abort();
    throw new Error("response too large");
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > MAX_BYTES) {
        ac.abort();
        throw new Error("response too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}
const GITHUB_API_HOST = "api.github.com";
const MAX_BYTES = 1_000_000;
const MAX_HOPS = 3;

/** Reason-only read-only public-repo token. Never GITHUB_TOKEN / GH_TOKEN. */
export function githubToken(env: NodeJS.ProcessEnv = process.env): string {
  return (env.JEB_GITHUB_TOKEN ?? "").trim();
}

export function githubHeaders(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const token = githubToken(env);
  return token ? { ...UA, Authorization: `Bearer ${token}` } : { ...UA };
}

export function githubRateLimited(
  status: number,
  headers: { get(name: string): string | null },
): boolean {
  if (status === 403 || status === 429) return true;
  return headers.get("x-ratelimit-remaining") === "0";
}

/** Same-host https only — GitHub 301s /repos/{owner}/{repo} to /repositories/{id}. */
export function githubApiRedirectTarget(from: URL, location: string): URL | null {
  let next: URL;
  try {
    next = new URL(location, from);
  } catch {
    return null;
  }
  if (next.protocol !== "https:" || next.hostname !== GITHUB_API_HOST) return null;
  if (from.hostname !== GITHUB_API_HOST) return null;
  return next;
}

export async function fetchGithubJson(
  url: URL,
  timeoutMs: number,
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    let current = url;
    for (let hop = 0; hop < MAX_HOPS; hop++) {
      const res = await fetch(current, {
        method: "GET",
        headers: githubHeaders(),
        signal: ac.signal,
        redirect: "manual",
      });
      if (githubRateLimited(res.status, res.headers)) throw new GithubUnavailableError();
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        const next = loc ? githubApiRedirectTarget(current, loc) : null;
        if (!next) throw new Error("github redirect rejected");
        current = next;
        continue;
      }
      const text = await readCappedText(res, ac);
      if (text.length > MAX_BYTES) throw new Error("response too large");
      if (!text) return { status: res.status, body: null, headers: res.headers };
      try {
        return { status: res.status, body: JSON.parse(text) as unknown, headers: res.headers };
      } catch {
        return { status: res.status, body: { error: "NON_JSON", message: "non-json response" }, headers: res.headers };
      }
    }
    throw new Error("github redirect hop limit");
  } finally {
    clearTimeout(t);
  }
}

export async function fetchGithubReleaseBody(
  owner: string,
  repo: string,
  tag: string,
  timeoutMs: number,
): Promise<string> {
  const url = new URL(`https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`);
  try {
    const res = await fetchGithubJson(url, timeoutMs);
    if (res.status !== 200 || !res.body || typeof res.body !== "object") return "";
    const body = (res.body as { body?: unknown }).body;
    return typeof body === "string" ? body : "";
  } catch (e) {
    if (e instanceof GithubUnavailableError) throw e;
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
    const res = await fetchGithubJson(url, timeoutMs);
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
  } catch (e) {
    if (e instanceof GithubUnavailableError) throw e;
    return [];
  }
}

export function attachReleaseBodies(
  releases: IndexedGitRelease[],
  bodies: Map<string, string>,
): Array<IndexedGitRelease & { body: string }> {
  return releases.map((r) => ({ ...r, body: bodies.get(r.html_url) ?? "" }));
}
