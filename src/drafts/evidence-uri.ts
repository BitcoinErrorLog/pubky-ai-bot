import { parsePostUri } from "../types.js";
import { appBaseUrl } from "../links.js";

const STATIC_HTTPS_HOSTS = new Set([
  "pubky.app",
  "www.pubky.app",
  "github.com",
  "www.github.com",
  "api.github.com",
  "pubky.org",
  "www.pubky.org",
]);

export function evidenceHttpsHosts(appUrl = appBaseUrl()): Set<string> {
  const hosts = new Set(STATIC_HTTPS_HOSTS);
  try {
    const host = new URL(appUrl).hostname.toLowerCase();
    if (host) hosts.add(host);
  } catch {
    /* keep static set */
  }
  return hosts;
}

/** Profile `pubky://<z32>` or a canonical 13-char post URI. */
export function isAllowedPubkyEvidenceUri(uri: string): boolean {
  const u = uri.trim();
  if (/^pubky:\/\/[a-z0-9]{52}$/i.test(u)) return true;
  try {
    parsePostUri(u);
    return true;
  } catch {
    return false;
  }
}

/**
 * Collection-time evidence URI gate: https-only web URLs on the generator
 * allowlist, or a canonical pubky post/profile URI with a 13-char post id.
 */
export function isAllowedEvidenceUri(uri: string, appUrl = appBaseUrl()): boolean {
  const u = uri.trim();
  if (!u) return false;
  if (u.startsWith("pubky://")) return isAllowedPubkyEvidenceUri(u);
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  return evidenceHttpsHosts(appUrl).has(parsed.hostname.toLowerCase());
}

export function filterEvidenceUris(uris: readonly string[], appUrl = appBaseUrl()): string[] {
  return [...new Set(uris.map((u) => u.trim()).filter((u) => isAllowedEvidenceUri(u, appUrl)))];
}
