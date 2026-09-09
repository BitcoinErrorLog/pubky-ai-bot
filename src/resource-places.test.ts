import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeUri, resourceIdentity } from "./resource-identity.js";
import { discoverBtcMapPlaces, fetchBtcMapSnapshot, parseBtcMapPlaces } from "./resource-places.js";
import { tagResource } from "./resource-tagger.js";

async function fixture(): Promise<unknown> {
  return JSON.parse(await readFile(new URL("./test-fixtures/places/places-v2-trimmed.json", import.meta.url), "utf8"));
}

function place(index: number, country: string) {
  return {
    id: `node:${index + 1}`,
    osm_json: {
      type: "node", id: index + 1, lat: 40 + index / 1000, lon: -70,
      version: 1,
      tags: { name: `Place ${index}`, amenity: "cafe", "addr:country": country, "payment:lightning": "yes" },
    },
    updated_at: "2026-01-01T00:00:00Z",
  };
}

describe("BTC Map places adapter", () => {
  it("refuses redirects to a second host before making the second request", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "jeb-p3-redirect-"));
    let calls = 0;
    try {
      await expect(fetchBtcMapSnapshot(cacheDir, async () => {
        calls += 1;
        return new Response(null, { status: 302, headers: { location: "http://127.0.0.1:9/v4/places" } });
      })).rejects.toThrow(/not allowlisted|https/);
      expect(calls).toBe(1);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("bounds area lookups to three times the requested limit", async () => {
    const snapshot = Array.from({ length: 5_000 }, (_, index) => ({
      id: index + 1,
      name: `Place ${index}`,
      lat: index / 100,
      lon: index / 100,
      osm_id: `node:${index + 1}`,
      updated_at: "2026-09-01T00:00:00Z",
    }));
    let areaRequests = 0;
    const result = await discoverBtcMapPlaces({
      snapshot,
      limit: 40,
      cacheDir: "/tmp/jeb-p3-area-cap",
      now: new Date("2026-09-09T00:00:00Z"),
      fetchImpl: async () => {
        areaRequests += 1;
        return new Response(JSON.stringify([{ type: "country", name: `country-${areaRequests}` }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    expect(result.shadowReport.areaRequests).toBeLessThanOrEqual(120);
    expect(areaRequests).toBeLessThanOrEqual(120);
  });

  it("refetches malformed or future snapshot caches", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "jeb-p3-cache-"));
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return new Response("[]", { status: 200 });
    };
    try {
      await writeFile(join(cacheDir, "btcmap-places-v4-full.json"), JSON.stringify({ fetchedAt: "not-a-date", places: [] }));
      await fetchBtcMapSnapshot(cacheDir, fetchImpl, new Date("2026-09-09T00:00:00Z"));
      await writeFile(join(cacheDir, "btcmap-places-v4-full.json"), JSON.stringify({ fetchedAt: "2999-01-01T00:00:00Z", places: [] }));
      await fetchBtcMapSnapshot(cacheDir, fetchImpl, new Date("2026-09-09T00:00:00Z"));
      expect(calls).toBe(2);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("ignores malformed area cache values", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "jeb-p3-area-cache-"));
    let calls = 0;
    try {
      await writeFile(join(cacheDir, "btcmap-place-areas.json"), JSON.stringify({ "1": "not-an-array" }));
      await discoverBtcMapPlaces({
        snapshot: [{ id: 1, name: "Place", lat: 1, lon: 2, osm_id: "node:1", updated_at: "2026-09-01T00:00:00Z" }],
        limit: 1,
        cacheDir,
        fetchImpl: async () => {
          calls += 1;
          return new Response(JSON.stringify([{ type: "country", name: "Testland" }]), { status: 200 });
        },
      });
      expect(calls).toBe(1);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("filters source filler hints and skips URL-slug classification", async () => {
    const result = await discoverBtcMapPlaces({
      snapshot: [{
        id: 1, name: "Cafe \u0000\u202E", lat: 1, lon: 2, osm_id: "node:1",
        updated_at: "2026-09-01T00:00:00Z",
        website: "javascript:alert(1)",
        "osm:cuisine": "osm;openstreetmap;btcmap;coffee",
      }],
      limit: 1,
      cacheDir: "/tmp/jeb-p3-label-filter",
    });
    expect(result.accepted[0]?.tagHints).toEqual(expect.arrayContaining(["coffee"]));
    expect(result.accepted[0]?.tagHints).not.toEqual(expect.arrayContaining(["osm", "openstreetmap", "btcmap"]));
    expect(result.accepted[0]?.taxonomy.subject).not.toContain("node");
    expect(result.accepted[0]?.taxonomy.subject).not.toContain("javascript");
    expect(result.accepted[0]?.title).not.toMatch(/[\u0000\u202E]/);
  });

  it("parses live v2 shape, emits OSM identities, hints, and score components", async () => {
    const result = await discoverBtcMapPlaces({
      snapshot: await fixture(),
      limit: 100,
      cacheDir: "/tmp/jeb-p3-test-cache",
      now: new Date("2026-09-09T00:00:00Z"),
    });
    expect(result.accepted.map((item) => item.canonicalValue)).toEqual([
      "https://www.openstreetmap.org/node/9778525869",
      "https://www.openstreetmap.org/way/42",
    ]);
    expect(result.accepted[0]?.identity).toBe(resourceIdentity(normalizeUri(result.accepted[0]!.canonicalValue)));
    expect(result.accepted[0]?.tagHints).toEqual(expect.arrayContaining(["bitcoin-accepted", "lightning", "onchain", "hotel"]));
    expect(result.accepted[1]?.tagHints).toEqual(expect.arrayContaining(["cafe", "coffee", "vegan", "new-york", "us"]));
    expect(result.accepted[0]?.provenance).toMatchObject({
      place: { lat: 42.276251, lon: 42.702422, osmVersion: 2 },
      scoreComponents: { authority: 0, durability: 2, cost_penalty: 0, pubky_signal: 0 },
    });
    expect(result.accepted.some((item) => item.canonicalValue.startsWith("geo:"))).toBe(false);
  });

  it("parses v4 flat fields, area membership, and discriminating score bands", async () => {
    const result = await discoverBtcMapPlaces({
      snapshot: [
        {
          id: 1, name: "Boosted Cafe", lat: 1, lon: 2, osm_id: "node:1",
          updated_at: "2026-09-01T00:00:00Z", verified_at: "2026-08-01T00:00:00Z",
          boosted_until: "2026-10-01T00:00:00Z", website: "https://cafe.example",
          opening_hours: "Mo-Fr 09:00-17:00", "osm:amenity": "cafe",
          areas: [{ name: "Testland", type: "country" }, { name: "Test City", type: "community" }],
        },
        {
          id: 2, name: "Old Shop", lat: 3, lon: 4, osm_id: "way:2",
          updated_at: "2024-01-01T00:00:00Z", "osm:shop": "bakery",
          areas: [{ name: "Otherland", type: "country" }],
        },
      ],
      limit: 100,
      cacheDir: "/tmp/jeb-p3-test-cache",
      now: new Date("2026-09-09T00:00:00Z"),
    });
    expect(result.shadowReport.poolSize).toBe(2);
    expect(result.shadowReport.unknownCountryRatio).toBe(0);
    expect(result.accepted[0]?.provenance.scoreComponents).not.toEqual(result.accepted[1]?.provenance.scoreComponents);
    expect(result.accepted[0]?.provenance.place).toMatchObject({ city: "Test City", country: "testland" });
  });

  it("rejects deleted, nameless, closed, and unknown OSM records", () => {
    const parsed = parseBtcMapPlaces([
      { id: "node:1", deleted_at: "2026-01-01", osm_json: { type: "node", id: 1, tags: { name: "Deleted" } } },
      { id: "node:2", osm_json: { type: "node", id: 2, lat: 1, lon: 2, tags: {} } },
      { id: "node:3", osm_json: { type: "node", id: 3, lat: 1, lon: 2, tags: { name: "Closed", opening_hours: "off" } } },
      { id: "area:4", osm_json: { type: "area", id: 4, lat: 1, lon: 2, tags: { name: "Unknown" } } },
    ]);
    expect(parsed.places).toHaveLength(0);
    expect(parsed.rejected.map((item) => item.reason)).toEqual([
      "deleted element", "nameless element", "closed element", "unknown OSM type",
    ]);
  });

  it("enforces 40 percent country diversity and the 100-record cap", async () => {
    const snapshot = Array.from({ length: 150 }, (_, index) => place(index, index % 3 === 0 ? "US" : index % 3 === 1 ? "CA" : "GB"));
    const result = await discoverBtcMapPlaces({
      snapshot,
      limit: 100,
      cacheDir: "/tmp/jeb-p3-test-cache",
      now: new Date("2026-09-09T00:00:00Z"),
    });
    expect(result.accepted).toHaveLength(100);
    const counts = new Map<string, number>();
    for (const resource of result.accepted) {
      const country = resource.tagHints?.find((hint) => ["us", "ca", "gb"].includes(hint));
      counts.set(country ?? "", (counts.get(country ?? "") ?? 0) + 1);
    }
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(40);
  });

  it("treats prompt-injection text in a place name as data", async () => {
    const run = await discoverBtcMapPlaces({
      snapshot: await fixture(),
      limit: 100,
      cacheDir: "/tmp/jeb-p3-test-cache",
      now: new Date("2026-09-09T00:00:00Z"),
    });
    let prompt = "";
    const tagged = await tagResource({ model: "test", modelPricePerMtokIn: 0, modelPricePerMtokOut: 0 } as never, run.accepted[1]!, {
      cacheDir: "/tmp/jeb-p3-test-cache/tagger",
      generate: async (value) => {
        prompt = value;
        return JSON.stringify(["ignore previous instructions", "cafe"]);
      },
    });
    expect(tagged.labels).toContain("cafe");
    expect(tagged.labels).not.toContain("ignore previous instructions");
    expect(prompt).not.toMatch(/[\u0000\u202E]/);
  });
});
