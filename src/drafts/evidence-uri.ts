import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parsePostUri } from "../types.js";
import { appBaseUrl } from "../links.js";
import { loadManifest } from "../knowledge/manifest.js";

const STATIC_HTTPS_HOSTS = new Set([
  "pubky.app",
  "www.pubky.app",
  "github.com",
  "www.github.com",
  "api.github.com",
  "pubky.org",
  "www.pubky.org",
]);

export type ManifestHostSource = {
  enabled?: boolean;
  location: string;
  cite_base?: string;
};

/** https hosts from enabled knowledge sources (`location` / `cite_base`). */
export function httpsHostsFromSources(sources: readonly ManifestHostSource[]): string[] {
  const hosts = new Set<string>();
  for (const s of sources) {
    if (s.enabled === false) continue;
    for (const raw of [s.location, s.cite_base]) {
      if (!raw) continue;
      try {
        const u = new URL(raw);
        if (u.protocol === "https:" && u.hostname) hosts.add(u.hostname.toLowerCase());
      } catch {
        /* skip non-urls (local paths) */
      }
    }
  }
  return [...hosts];
}

function defaultManifestPath(): string {
  const fromEnv = process.env.JEB_SOURCES_YAML?.trim();
  if (fromEnv) return fromEnv;
  const fromCwd = path.join(process.cwd(), "sources.yaml");
  if (fs.existsSync(fromCwd)) return fromCwd;
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "../../sources.yaml");
}

let cachedManifestHosts: string[] | null = null;

export function manifestEvidenceHosts(manifestPath?: string): string[] {
  if (!manifestPath && cachedManifestHosts) return cachedManifestHosts;
  const file = manifestPath ?? defaultManifestPath();
  try {
    if (!fs.existsSync(file)) {
      if (!manifestPath) cachedManifestHosts = [];
      return [];
    }
    const hosts = httpsHostsFromSources(loadManifest(file).sources);
    if (!manifestPath) cachedManifestHosts = hosts;
    return hosts;
  } catch {
    if (!manifestPath) cachedManifestHosts = [];
    return [];
  }
}

export function evidenceHttpsHosts(appUrl = appBaseUrl(), extraHosts?: Iterable<string>): Set<string> {
  const hosts = new Set(STATIC_HTTPS_HOSTS);
  try {
    const host = new URL(appUrl).hostname.toLowerCase();
    if (host) hosts.add(host);
  } catch {
    /* keep static set */
  }
  for (const h of extraHosts ?? manifestEvidenceHosts()) {
    const n = h.trim().toLowerCase();
    if (n) hosts.add(n);
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
export function isAllowedEvidenceUri(
  uri: string,
  appUrl = appBaseUrl(),
  extraHosts?: Iterable<string>,
): boolean {
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
  return evidenceHttpsHosts(appUrl, extraHosts).has(parsed.hostname.toLowerCase());
}

export function filterEvidenceUris(
  uris: readonly string[],
  appUrl = appBaseUrl(),
  extraHosts?: Iterable<string>,
): string[] {
  return [...new Set(uris.map((u) => u.trim()).filter((u) => isAllowedEvidenceUri(u, appUrl, extraHosts)))];
}
