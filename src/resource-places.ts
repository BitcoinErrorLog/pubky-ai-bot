import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  discoverResources,
  type ExternalResourceInput,
  type ResourceRun,
} from "./external-resources.js";
import { RESOURCE_CONFIG_VERSION } from "./resource-taxonomy.js";
import { assertAllowedResourceReadUrl, BTCMAP_PLACES_API_URL } from "./outbound-gate.js";

export type BtcMapPlace = {
  id?: unknown;
  name?: unknown;
  lat?: unknown;
  lon?: unknown;
  osm_id?: unknown;
  address?: unknown;
  website?: unknown;
  opening_hours?: unknown;
  boosted_until?: unknown;
  areas?: unknown;
  [key: `osm:${string}`]: unknown;
  osm_json?: unknown;
  tags?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  verified_at?: unknown;
  deleted_at?: unknown;
};

type ParsedPlace = {
  input: ExternalResourceInput;
  country: string;
  city?: string;
  scoreComponents: Record<string, number>;
};

const OSM_TYPES = new Set(["node", "way", "relation"]);
const RELEVANT_TAGS = [
  "amenity", "shop", "tourism", "cuisine", "payment:lightning", "payment:lightning_contactless",
  "payment:onchain", "addr:city", "addr:country", "addr:neighbourhood", "website", "opening_hours",
];
const ATTRIBUTION = "© OpenStreetMap contributors (ODbL); BTC Map";
const BTCMAP_PAGE_SIZE = 1000;
const BTCMAP_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const BTCMAP_PLACE_FIELDS = [
  "id", "name", "lat", "lon", "updated_at", "verified_at", "boosted_until", "deleted_at",
  "created_at",
  "osm_id", "address", "opening_hours", "website",
  "osm:addr:city", "osm:addr:country", "osm:addr:neighbourhood", "osm:amenity",
  "osm:shop", "osm:tourism", "osm:cuisine", "osm:payment:lightning",
  "osm:payment:lightning_contactless", "osm:payment:onchain", "osm:check_date",
  "osm:survey:date",
].join(",");

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseId(id: unknown, osm: Record<string, unknown>): { type: string; id: number } | undefined {
  const raw = text(id) ?? `${text(osm.type) ?? ""}:${String(osm.id ?? "")}`;
  const match = /^(node|way|relation):(\d+)$/.exec(raw);
  if (!match || !OSM_TYPES.has(match[1]!)) return undefined;
  const numericId = Number(match[2]);
  return Number.isSafeInteger(numericId) ? { type: match[1]!, id: numericId } : undefined;
}

function isClosed(tags: Record<string, unknown>): boolean {
  if (Object.keys(tags).some((key) => key.startsWith("disused:"))) return true;
  const hours = text(tags.opening_hours)?.toLowerCase().trim();
  return hours === "off" || hours === "closed" || hours === "permanently closed";
}

function tagValues(value: unknown): string[] {
  return String(value ?? "").split(/[;,]/).map((part) => part.trim().toLowerCase().replace(/\s+/g, "-")).filter(Boolean);
}

function placeDescription(tags: Record<string, unknown>, btcTags: Record<string, unknown>): string {
  return RELEVANT_TAGS
    .map((key) => {
      const value = text(tags[key]) ?? text(btcTags[key]);
      return value ? `${key}=${value}` : undefined;
    })
    .filter((value): value is string => Boolean(value))
    .join("; ");
}

function flatTags(value: BtcMapPlace, osm: Record<string, unknown> | undefined): Record<string, unknown> {
  const tags = { ...(record(osm?.tags) ?? {}), ...(record(value.tags) ?? {}) };
  const raw = value as Record<string, unknown>;
  for (const key of ["name", "website", "opening_hours", "address"]) {
    if (raw[key] !== undefined) tags[key] = raw[key];
  }
  for (const [key, tag] of Object.entries(value)) {
    if (key.startsWith("osm:")) tags[key.slice(4)] = tag;
  }
  return tags;
}

function hintsFor(tags: Record<string, unknown>, btcTags: Record<string, unknown>): string[] {
  const hints = new Set<string>();
  hints.add("bitcoin-accepted");
  if (["yes", "true", "designated"].includes(text(tags["payment:lightning"])?.toLowerCase() ?? "") ||
      ["yes", "true", "designated"].includes(text(tags["payment:lightning_contactless"])?.toLowerCase() ?? "")) hints.add("lightning");
  if (["yes", "true", "designated"].includes(text(tags["payment:onchain"])?.toLowerCase() ?? "")) hints.add("onchain");
  for (const key of ["amenity", "shop", "tourism", "city", "addr:city", "addr:country"]) {
    for (const value of tagValues(tags[key] ?? btcTags[key])) hints.add(value);
  }
  for (const key of ["cuisine"]) for (const value of tagValues(tags[key])) hints.add(value);
  return [...hints].filter((value) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 20);
}

function areaRows(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(record).filter((row): row is Record<string, unknown> => Boolean(row)) : [];
}

function areaName(value: unknown, type: string): string | undefined {
  const area = areaRows(value).find((row) => row.type === type || record(row.tags)?.type === type);
  return text(area?.name) ?? text(record(area?.tags)?.name) ?? text(area?.alias);
}

function areaNames(value: unknown): { community?: string } {
  return { community: areaName(value, "community") };
}

function boostScore(value: unknown, nowMs: number): number {
  const expires = value ? Date.parse(String(value)) : NaN;
  return Number.isFinite(expires) && expires > nowMs ? 4 : 0;
}

function richnessScore(tags: Record<string, unknown>): number {
  return ["name", "website", "opening_hours", "cuisine"].filter((key) => text(tags[key])).length;
}

function freshnessScore(value: string | undefined, nowMs: number): number {
  if (!value) return 0;
  const age = nowMs - Date.parse(value);
  if (!Number.isFinite(age) || age < 0) return 0;
  return age <= 90 * 24 * 60 * 60 * 1000 ? 3 : age <= 365 * 24 * 60 * 60 * 1000 ? 2 : 1;
}

function durabilityScore(value: string | undefined, nowMs: number): number {
  if (!value) return 1;
  const age = nowMs - Date.parse(value);
  if (!Number.isFinite(age) || age < 0) return 1;
  return age >= 2 * 365 * 24 * 60 * 60 * 1000 ? 3 : age >= 180 * 24 * 60 * 60 * 1000 ? 2 : 1;
}

async function addAreaMembership(
  places: BtcMapPlace[],
  cacheDir: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const path = join(cacheDir, "btcmap-place-areas.json");
  let cached: Record<string, unknown> = {};
  try {
    cached = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    // The area cache is optional and is rebuilt from the read-only endpoint.
  }
  const pending = places.filter((place) => place.areas === undefined && place.id !== undefined && number(place.lat) !== undefined && number(place.lon) !== undefined);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < pending.length) {
      const place = pending[cursor++]!;
      const key = String(place.id);
      if (cached[key] !== undefined) {
        place.areas = cached[key];
        continue;
      }
      const url = new URL("/v4/areas", BTCMAP_PLACES_API_URL);
      url.searchParams.set("lat", String(place.lat));
      url.searchParams.set("lon", String(place.lon));
      assertAllowedResourceReadUrl(url.toString());
      try {
        const response = await fetchImpl(url, { headers: { accept: "application/json" } });
        const areas = response.ok ? await response.json() : [];
        cached[key] = Array.isArray(areas) ? areas : [];
        place.areas = cached[key];
      } catch {
        cached[key] = [];
        place.areas = [];
      }
    }
  };
  await Promise.all(Array.from({ length: 16 }, () => worker()));
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(cached), { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

function parsePlace(value: BtcMapPlace, nowMs: number): ParsedPlace | { reason: string } {
  if (value.deleted_at) return { reason: "deleted element" };
  const osm = record(value.osm_json);
  const tags = flatTags(value, osm);
  const btcTags = record(value.tags) ?? {};
  const parsedId = parseId(value.osm_id ?? value.id, osm ?? {});
  const name = text(value.name) ?? text(tags.name);
  if (!parsedId) return { reason: "unknown OSM type" };
  if (!name) return { reason: "nameless element" };
  if (isClosed(tags)) return { reason: "closed element" };
  const lat = number(value.lat) ?? number(osm?.lat) ?? number(record(osm?.center)?.lat);
  const lon = number(value.lon) ?? number(osm?.lon) ?? number(record(osm?.center)?.lon);
  if (lat === undefined || lon === undefined || lat < -90 || lat > 90 || lon < -180 || lon > 180) return { reason: "missing coordinates" };
  const updatedAt = text(value.updated_at);
  const verifiedAt = text(value.verified_at) ?? text(tags["check_date"]) ?? text(tags["survey:date"]);
  const verificationAge = verifiedAt ? nowMs - Date.parse(verifiedAt) : Number.POSITIVE_INFINITY;
  const authority = verificationAge <= 90 * 24 * 60 * 60 * 1000 ? 4 :
    verificationAge <= 365 * 24 * 60 * 60 * 1000 ? 3 :
      Number.isFinite(verificationAge) ? 1 : 0;
  const city = text(tags["addr:city"]) ?? text(tags["city"]);
  const country = (text(tags["addr:country"]) ?? text(tags["is_in:country_code"]) ?? areaName(value.areas, "country") ?? "unknown").toLowerCase();
  const canonical = `https://www.openstreetmap.org/${parsedId.type}/${parsedId.id}`;
  const scoreComponents = {
    authority,
    durability: durabilityScore(text(value.created_at) ?? updatedAt, nowMs),
    origin_engagement: boostScore(value.boosted_until, nowMs) + richnessScore(tags),
    freshness: freshnessScore(updatedAt, nowMs),
    cost_penalty: 0,
    pubky_signal: 0,
  };
  const input: ExternalResourceInput = {
    family: "url",
    value: canonical,
    source: "btcmap-places",
    labels: [],
    tagHints: hintsFor(tags, btcTags),
    title: name,
    description: placeDescription(tags, btcTags),
    observedAt: updatedAt,
    taxonomy: { geography: [] },
    placeProvenance: {
      attribution: ATTRIBUTION,
      lat: Number(lat.toFixed(6)),
      lon: Number(lon.toFixed(6)),
      city,
      country,
      osmVersion: number(osm?.version),
      updatedAt,
      verifiedAt,
    },
  };
  const areas = areaNames(value.areas);
  if (!input.placeProvenance) throw new Error("place provenance missing");
  input.placeProvenance.city = city ?? areas.community;
  input.placeProvenance.country = country;
  return { input, country, city: city ?? areas.community, scoreComponents };
}

export function parseBtcMapPlaces(snapshot: unknown, now = new Date()): { places: ParsedPlace[]; rejected: Array<{ id?: unknown; reason: string }> } {
  const rows = Array.isArray(snapshot) ? snapshot : record(snapshot)?.places;
  if (!Array.isArray(rows)) throw new Error("BTC Map snapshot must be an array or { places: [] }");
  const places: ParsedPlace[] = [];
  const rejected: Array<{ id?: unknown; reason: string }> = [];
  for (const row of rows) {
    const source = record(row);
    const parsed = source ? parsePlace(source as BtcMapPlace, now.getTime()) : { reason: "invalid record" };
    if ("reason" in parsed) rejected.push({ id: source?.id, reason: parsed.reason });
    else places.push(parsed);
  }
  return { places, rejected };
}

function selectPlaces(places: ParsedPlace[], limit: number): ParsedPlace[] {
  const byCountry = new Map<string, number>();
  const byCity = new Map<string, number>();
  for (const place of places) {
    if (place.city) byCity.set(place.city, (byCity.get(place.city) ?? 0) + 1);
  }
  const maxCountry = Math.floor(limit * 0.4);
  return [...places]
    .sort((a, b) => (b.scoreComponents.authority - a.scoreComponents.authority) ||
      (b.scoreComponents.origin_engagement - a.scoreComponents.origin_engagement) ||
      ((byCity.get(b.city ?? "") ?? 0) - (byCity.get(a.city ?? "") ?? 0)) ||
      a.input.value.localeCompare(b.input.value))
    .filter((place) => {
      const count = byCountry.get(place.country) ?? 0;
      if (count >= maxCountry) return false;
      byCountry.set(place.country, count + 1);
      return true;
    })
    .slice(0, limit);
}

export async function fetchBtcMapSnapshot(cacheDir: string, fetchImpl: typeof fetch = fetch, now = new Date()): Promise<unknown> {
  const path = join(cacheDir, "btcmap-places-v4-full.json");
  try {
    const cached = JSON.parse(await readFile(path, "utf8")) as { fetchedAt?: string; places?: unknown[] };
    if (!cached.fetchedAt || !Array.isArray(cached.places) || now.getTime() - Date.parse(cached.fetchedAt) > BTCMAP_CACHE_TTL_MS) {
      throw new Error("expired BTC Map cache");
    }
    return cached.places;
  } catch {
    const places: BtcMapPlace[] = [];
    let updatedSince = "1970-01-01T00:00:00.000Z";
    while (true) {
      const apiUrl = new URL(BTCMAP_PLACES_API_URL);
      apiUrl.searchParams.set("fields", BTCMAP_PLACE_FIELDS);
      apiUrl.searchParams.set("updated_since", updatedSince);
      apiUrl.searchParams.set("include_deleted", "true");
      apiUrl.searchParams.set("limit", String(BTCMAP_PAGE_SIZE));
      assertAllowedResourceReadUrl(apiUrl.toString());
      const response = await fetchImpl(apiUrl, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`BTC Map sync fetch failed: ${response.status}`);
      const page = await response.json() as unknown;
      if (!Array.isArray(page)) throw new Error("BTC Map sync response must be an array");
      places.push(...page as BtcMapPlace[]);
      if (page.length < BTCMAP_PAGE_SIZE) break;
      const lastUpdated = page.at(-1) && record(page.at(-1))?.updated_at;
      if (typeof lastUpdated !== "string" || lastUpdated <= updatedSince) throw new Error("BTC Map sync cursor did not advance");
      updatedSince = lastUpdated;
    }
    await addAreaMembership(places, cacheDir, fetchImpl);
    const body = JSON.stringify({ fetchedAt: now.toISOString(), places });
    await mkdir(cacheDir, { recursive: true, mode: 0o700 });
    await writeFile(path, body, { encoding: "utf8", mode: 0o600 });
    await chmod(path, 0o600);
    return places;
  }
}

export async function discoverBtcMapPlaces(opts: {
  limit: number;
  configVersion?: string;
  cacheDir: string;
  snapshot?: unknown;
  now?: Date;
  fetchImpl?: typeof fetch;
}): Promise<ResourceRun> {
  const snapshot = opts.snapshot ?? await fetchBtcMapSnapshot(opts.cacheDir, opts.fetchImpl, opts.now);
  const parsed = parseBtcMapPlaces(snapshot, opts.now);
  const selected = selectPlaces(parsed.places, opts.limit);
  const run = discoverResources(selected.map((place) => place.input), {
    category: "pubky",
    limit: opts.limit,
    configVersion: opts.configVersion ?? RESOURCE_CONFIG_VERSION,
    now: opts.now,
  });
  const rejectionHistogram = parsed.rejected.reduce<Record<string, number>>((counts, item) => {
    counts[item.reason] = (counts[item.reason] ?? 0) + 1;
    return counts;
  }, {});
  const unknownCountries = parsed.places.filter((place) => place.country === "unknown").length;
  run.shadowReport.poolSize = parsed.places.length + parsed.rejected.length;
  run.shadowReport.unknownCountryRatio = parsed.places.length ? unknownCountries / parsed.places.length : 1;
  run.shadowReport.rejectionHistogram = rejectionHistogram;
  for (const resource of run.accepted) {
    const source = selected.find((place) => place.input.value === resource.canonicalValue);
    if (!source) continue;
    resource.provenance = {
      ...resource.provenance,
      ...(source.input.placeProvenance ? { place: source.input.placeProvenance } : {}),
      scoreComponents: source.scoreComponents,
    };
  }
  return run;
}

