import { readFileSync } from "node:fs";
import { parseManifest } from "./manifest.js";
import { defaultManifestPath } from "./run-ingest.js";

/**
 * Document titles from the public knowledge-base corpus that are products,
 * portals, or sites. Generic notes (Introduction, Posts, Tags, FAQ) are
 * omitted so a graph question about posts does not look like a product ask.
 * Manifest `product` values are merged in at load time.
 */
export const KNOWLEDGE_BASE_PRODUCT_NAMES: readonly string[] = [
  "pubky marketplace",
  "pubky passport",
  "paykit",
  "locks",
  "homegate",
  "homeserver",
  "homeservers",
  "pkarr",
  "pkdns",
  "pubky ring",
  "pubky noise",
  "pubky cli",
  "pubky docker",
  "pubky explorer",
  "pubky nexus",
  "pubky app",
  "pubky moderation",
  "pubky backup",
  "pubky core",
  "http relay",
  "mainline dht",
  "semantic social graph",
  "credible exit",
  "vibes",
  "vibes portal",
  "chessky",
  "englishify",
  "eventky",
  "pubky arena",
  "pubky world",
  "graph explorer",
  "your pubchi",
  "mention pills",
  "light mode",
  "sync status",
  "bitkit",
  "blocktank",
  "atomicity",
  "slashtags",
  "synonym",
  "nexus scout",
  "pubky-app",
  "pubky-core",
  "pubky-nexus",
  "pubky-noise",
  "pubky-ring",
];

const GENERIC_COMPONENT = new Set([
  "docs",
  "spec",
  "readme",
  "website",
  "examples",
  "skill",
  "llms",
  "articles",
  "knowledge",
  "base",
  "fork",
]);

export type CorpusSourceName = {
  product: string;
  id: string;
  component: string;
  enabled?: boolean;
};

/** Surface forms a manifest source contributes: product, id, and a non-generic component token. */
export function namesFromSources(sources: readonly CorpusSourceName[]): string[] {
  const names: string[] = [];
  for (const source of sources) {
    if (source.enabled === false) continue;
    names.push(source.product, source.id);
    for (const part of source.component.split("-")) {
      if (part.length >= 4 && !GENERIC_COMPONENT.has(part)) names.push(part);
    }
  }
  return names;
}

export function namesFromManifestYaml(yamlText: string): string[] {
  return namesFromSources(parseManifest(yamlText).sources);
}

let cached: readonly string[] | null = null;

/** Manifest products plus knowledge-base titles. A missing manifest keeps the title list. */
export function corpusProductNames(manifestPath = defaultManifestPath()): readonly string[] {
  if (cached && manifestPath === defaultManifestPath()) return cached;
  let fromManifest: string[] = [];
  try {
    fromManifest = namesFromManifestYaml(readFileSync(manifestPath, "utf8"));
  } catch {
    fromManifest = [];
  }
  const names = dedupeNames([...KNOWLEDGE_BASE_PRODUCT_NAMES, ...fromManifest]);
  if (manifestPath === defaultManifestPath()) cached = names;
  return names;
}

export function dedupeNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    const key = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join(" ");
    if (key.length < 3 || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}
