import { createHash } from "node:crypto";
import { normalizeUri } from "./resource-identity.js";

export const RESOURCE_CONFIG_VERSION = "external-resources-v3-bitcoin-canon";
export const RESOURCE_SOURCE_IDS = ["staging-catalog", "musicbrainz", "geonames", "btcmap-places", "bitcoin-canon", "pubky-ecosystem", "low-value-aggregator", "pubky-posts"] as const;
export type ResourceSourceId = (typeof RESOURCE_SOURCE_IDS)[number];

export type ResourceFamily = "url" | "geocoordinate" | "stable-identifier";

export interface ResourceSourceDefinition {
  id: string;
  priorityTier: 1 | 2 | 3;
  priority: number;
  families: readonly ResourceFamily[];
  freshnessWindowMs: number;
  cadenceMs: number;
  costCeilingUsd: number;
  robots: "required" | "not-applicable";
  licensing: "public" | "review-required";
  enabled: boolean;
  unmatched: "reject" | "source-default";
  allowOperatorLabels?: boolean;
  allowIdnHosts?: boolean;
}

export const RESOURCE_SOURCE_REGISTRY: readonly ResourceSourceDefinition[] = [
  {
    id: "pubky-posts",
    priorityTier: 1,
    priority: 120,
    families: ["stable-identifier"],
    freshnessWindowMs: 90 * 24 * 60 * 60 * 1000,
    cadenceMs: 24 * 60 * 60 * 1000,
    costCeilingUsd: 5,
    robots: "not-applicable",
    licensing: "public",
    enabled: true,
    unmatched: "source-default",
  },
  {
    id: "staging-catalog",
    priorityTier: 1,
    priority: 100,
    families: ["url", "stable-identifier"],
    freshnessWindowMs: 30 * 24 * 60 * 60 * 1000,
    cadenceMs: 24 * 60 * 60 * 1000,
    costCeilingUsd: 0,
    robots: "required",
    licensing: "public",
    enabled: true,
    unmatched: "source-default",
    allowOperatorLabels: true,
    allowIdnHosts: false,
  },
  {
    id: "musicbrainz",
    priorityTier: 1,
    priority: 90,
    families: ["url", "stable-identifier"],
    freshnessWindowMs: 7 * 24 * 60 * 60 * 1000,
    cadenceMs: 24 * 60 * 60 * 1000,
    costCeilingUsd: 0,
    robots: "required",
    licensing: "public",
    enabled: true,
    unmatched: "reject",
  },
  {
    id: "geonames",
    priorityTier: 2,
    priority: 70,
    families: ["geocoordinate"],
    freshnessWindowMs: 365 * 24 * 60 * 60 * 1000,
    cadenceMs: 30 * 24 * 60 * 60 * 1000,
    costCeilingUsd: 0,
    robots: "required",
    licensing: "public",
    enabled: true,
    unmatched: "reject",
  },
  {
    id: "btcmap-places",
    priorityTier: 1,
    priority: 95,
    families: ["url"],
    freshnessWindowMs: 365 * 24 * 60 * 60 * 1000,
    cadenceMs: 24 * 60 * 60 * 1000,
    costCeilingUsd: 0,
    robots: "not-applicable",
    licensing: "public",
    enabled: true,
    unmatched: "source-default",
  },
  {
    id: "bitcoin-canon",
    priorityTier: 1,
    priority: 110,
    families: ["url"],
    freshnessWindowMs: 365 * 24 * 60 * 60 * 1000,
    cadenceMs: 7 * 24 * 60 * 60 * 1000,
    costCeilingUsd: 5,
    robots: "required",
    licensing: "public",
    enabled: true,
    unmatched: "source-default",
    allowOperatorLabels: true,
    allowIdnHosts: false,
  },
  {
    id: "pubky-ecosystem",
    priorityTier: 1,
    priority: 115,
    families: ["url"],
    freshnessWindowMs: 365 * 24 * 60 * 60 * 1000,
    cadenceMs: 7 * 24 * 60 * 60 * 1000,
    costCeilingUsd: 0,
    robots: "required",
    licensing: "review-required",
    enabled: true,
    unmatched: "source-default",
    allowOperatorLabels: true,
    allowIdnHosts: false,
  },
  {
    id: "low-value-aggregator",
    priorityTier: 3,
    priority: 10,
    families: ["url", "stable-identifier"],
    freshnessWindowMs: 24 * 60 * 60 * 1000,
    cadenceMs: 24 * 60 * 60 * 1000,
    costCeilingUsd: 0,
    robots: "required",
    licensing: "review-required",
    enabled: false,
    unmatched: "reject",
  },
];

const CRAWLER_CORPUS_SOURCE: Omit<ResourceSourceDefinition, "id"> = {
  priorityTier: 1,
  priority: 100,
  families: ["url"],
  freshnessWindowMs: 30 * 24 * 60 * 60 * 1000,
  cadenceMs: 24 * 60 * 60 * 1000,
  costCeilingUsd: 0,
  robots: "required",
  licensing: "public",
  enabled: true,
  unmatched: "reject",
};

export const RESOURCE_FAMILY_REGISTRY: readonly { id: ResourceFamily; description: string }[] = [
  { id: "url", description: "Canonical HTTPS URL; adapter is canonicalizeUrl in external-resources.ts." },
  { id: "geocoordinate", description: "Latitude and longitude in decimal degrees, normalized to signed decimal form." },
  { id: "stable-identifier", description: "DOI, ISBN, Nostr event id, Bluesky AT URI, or npm/PyPI package identifier." },
];

export type Taxonomy = {
  domain: string[];
  type: string[];
  subject: string[];
  geography: string[];
  sourceStatus: string[];
};

export const EMPTY_TAXONOMY: Taxonomy = { domain: [], type: [], subject: [], geography: [], sourceStatus: [] };

const MUSIC_TYPES = new Set(["track", "album", "artist", "label", "playlist", "music-track", "music-album", "music-artist", "music-label", "music-playlist", "music-recording"]);
const MUSIC_HOSTS: Record<string, string> = {
  "music.apple.com": "music",
  "musicbrainz.org": "music",
  "open.spotify.com": "music",
  "spotify.com": "music",
  "bandcamp.com": "music",
  "soundcloud.com": "music",
};
const NEXUS_TAG_MAX_CHARS = 20;
const MUSIC_PATH_TYPES: Record<string, string> = {
  track: "track",
  recording: "track",
  album: "album",
  release: "album",
  artist: "artist",
  label: "label",
  playlist: "playlist",
};

export function emptyTaxonomy(): Taxonomy {
  return { domain: [], type: [], subject: [], geography: [], sourceStatus: [] };
}

export function mergeTaxonomy(input: Partial<Taxonomy> | undefined, value: string, family: ResourceFamily): Taxonomy {
  const result = emptyTaxonomy();
  for (const key of Object.keys(result) as (keyof Taxonomy)[]) {
    result[key] = [...new Set((input?.[key] ?? []).map((tag) => tag.trim().toLowerCase()).filter(Boolean))].sort();
  }
  if (family === "url") {
    try {
      const host = new URL(value).hostname.toLowerCase().replace(/\.+$/, "");
      const musicDomain = MUSIC_HOSTS[host] ?? Object.entries(MUSIC_HOSTS).find(([suffix]) => host.endsWith(`.${suffix}`))?.[1];
      if (musicDomain) {
        result.domain = [...new Set([...result.domain, musicDomain])].sort();
        const pathType = value.split("?")[0]!.split("/").find((part) => MUSIC_PATH_TYPES[part.toLowerCase()]);
        if (pathType) result.type = [...new Set([...result.type, `music-${MUSIC_PATH_TYPES[pathType.toLowerCase()]!}`])].sort();
      }
    } catch {
      // URL validation supplies the rejection; taxonomy stays deterministic for invalid input.
    }
  }
  return result;
}

export function flattenTaxonomy(taxonomy: Taxonomy): string[] {
  return [...new Set(Object.values(taxonomy).flat())].sort();
}

export function validateTaxonomy(taxonomy: Taxonomy): string | null {
  const all = flattenTaxonomy(taxonomy);
  if (all.some((tag) => tag.length < 1 || tag.length > NEXUS_TAG_MAX_CHARS || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tag) || tag.split("-").length > 3)) {
    return "invalid taxonomy label";
  }
  if (taxonomy.domain.some((tag) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tag))) return "invalid domain tag";
  if (taxonomy.type.some((tag) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tag))) return "invalid type tag";
  const musicDomain = taxonomy.domain.includes("music") || taxonomy.domain.some((tag) => tag.startsWith("music-"));
  if (taxonomy.type.some((tag) => MUSIC_TYPES.has(tag)) && !musicDomain) return "music type requires music domain";
  if (musicDomain && taxonomy.type.some((tag) => !MUSIC_TYPES.has(tag))) return "music domain requires music type";
  return null;
}

export function canonicalizeGeocoordinate(raw: string): string {
  const parts = raw.trim().split(/\s*,\s*/);
  if (parts.length !== 2 || parts.some((part) => !/^-?(?:\d+|\d*\.\d+)$/.test(part))) throw new Error("invalid geocoordinate");
  const latitude = Number(parts[0]);
  const longitude = Number(parts[1]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    throw new Error("invalid geocoordinate");
  }
  return `geo:${Object.is(latitude, -0) ? 0 : latitude},${Object.is(longitude, -0) ? 0 : longitude}`;
}

function isbnCanonical(raw: string): string | null {
  const compact = raw.replace(/[-\s]/g, "").toUpperCase();
  if (!/^(?:\d{9}[\dX]|\d{13})$/.test(compact)) return null;
  if (compact.length === 10) {
    const sum = [...compact].reduce((total, char, index) => total + (char === "X" ? 10 : Number(char)) * (10 - index), 0);
    return sum % 11 === 0 ? `isbn:${compact}` : null;
  }
  const sum = [...compact].reduce((total, char, index) => total + Number(char) * (index % 2 ? 3 : 1), 0);
  return sum % 10 === 0 ? `isbn:${compact}` : null;
}

export function canonicalizeStableIdentifier(raw: string, kind?: string): string {
  const value = raw.trim();
  const isbn = isbnCanonical(value);
  if (isbn) return isbn;
  const doi = value.replace(/^https?:\/\/doi\.org\//i, "").replace(/^doi:/i, "").trim().toLowerCase();
  if (/^10\.\d{4,9}\/\S+$/.test(doi)) return `doi:${doi}`;
  if (/^[0-9a-f]{64}$/i.test(value)) return `nostr:${value.toLowerCase()}`;
  if (/^at:\/\/did:[a-z0-9]+:[A-Za-z0-9.:%-]+\/[a-z0-9.-]+\/[a-zA-Z0-9._~-]+$/i.test(value)) {
    const parts = value.split("/");
    return `bluesky:${parts[0].toLowerCase()}//${parts[2].toLowerCase()}/${parts[3].toLowerCase()}/${parts[4]}`;
  }
  const packageMatch = /^(npm|pypi):([a-z0-9_.-]+(?:\/[a-z0-9_.-]+)?)$/i.exec(value);
  if (packageMatch) return `pkg:${packageMatch[1].toLowerCase()}/${packageMatch[2].toLowerCase()}`;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return normalizeUri(value);
  throw new Error(`unsupported stable identifier${kind ? ` type ${kind}` : ""}`);
}

export function taxonomyHash(taxonomy: Taxonomy): string {
  return createHash("sha256").update(JSON.stringify(taxonomy)).digest("hex");
}

export function sourceDefinition(source: string): ResourceSourceDefinition | undefined {
  const exact = RESOURCE_SOURCE_REGISTRY.find((entry) => entry.id === source);
  if (exact) return exact;
  if (source.startsWith("web-index-")) return { id: source, ...CRAWLER_CORPUS_SOURCE };
  return undefined;
}
