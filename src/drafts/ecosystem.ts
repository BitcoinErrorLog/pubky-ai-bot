/** Pubky-ecosystem GitHub repos eligible for release radar and what-changed. */

export const PUBKY_ECOSYSTEM_REPO_NAMES = [
  "pubky-app",
  "pubky-ring",
  "pubky-core",
  "pkarr",
  "pubky-nexus",
  "nexus-scout",
  "homegate",
  "paykit",
  "paykit-rs",
  "locks",
  "pubky-locks",
  "loopky",
  "hypercolor",
  "pubky-ai-bot",
] as const;

const NAMED = new Set<string>(PUBKY_ECOSYSTEM_REPO_NAMES.map((n) => n.toLowerCase()));

export function parseGithubRepo(location: string): { owner: string; repo: string } | null {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/|$)/i.exec(location.trim());
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

export function isPubkyEcosystemRepo(owner: string, repo: string): boolean {
  const o = owner.toLowerCase();
  const r = repo.toLowerCase();
  if (r.startsWith("bitkit")) return false;
  if (o === "pubky") return true;
  return NAMED.has(r);
}

/** `owner/repo` slug from GitHub API rows. */
export function isPubkyEcosystemSlug(slug: string): boolean {
  const m = /^([\w.-]+)\/([\w.-]+)$/.exec(slug.trim());
  if (!m) return false;
  return isPubkyEcosystemRepo(m[1], m[2]);
}

export function isPubkyEcosystemLocation(location: string): boolean {
  const parsed = parseGithubRepo(location);
  if (!parsed) return false;
  return isPubkyEcosystemRepo(parsed.owner, parsed.repo);
}
