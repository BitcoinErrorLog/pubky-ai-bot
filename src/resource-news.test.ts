import { readFile, mkdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { configFromProcessEnv } from "./config.js";
import { NEWS_FEEDS, NEWS_MAX_BODY_BYTES, discoverNews, parseNewsFeed } from "./resource-news.js";
import { runResourcesCli } from "./resources.js";
import { RESOURCE_CONFIG_VERSION } from "./resource-taxonomy.js";
import { sourceTreeHash } from "./source-tree-hash.js";
import { resetFetchState } from "./resource-fetch.js";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

async function fixtures(): Promise<Partial<Record<(typeof NEWS_FEEDS)[number]["id"], string>>> {
  return Object.fromEntries(await Promise.all(NEWS_FEEDS.map(async (feed) => [
    feed.id,
    await readFile(new URL(`./test-fixtures/news/${feed.id}.xml`, import.meta.url), "utf8"),
  ])));
}

describe("news resource adapter", () => {
  it("parses live fixtures into metadata-only recent article records", async () => {
    const result = await discoverNews({ fixtures: await fixtures(), limit: 40, now: new Date("2026-09-11T00:00:00.000Z") });
    expect(result.shadowReport.halt).toBeUndefined();
    expect(result.accepted.length).toBeGreaterThan(0);
    expect(result.accepted.every((item) => item.taxonomy.type.includes("article"))).toBe(true);
    expect(result.accepted.every((item) => !item.bodyText)).toBe(true);
    expect(result.accepted.every((item) => NEWS_FEEDS.some((feed) => feed.publicationHosts.includes(new URL(item.displayValue).hostname)))).toBe(true);
  });

  it("canonicalizes tracking parameters and rejects an external item host", async () => {
    const feed = NEWS_FEEDS[0]!;
    const xml = `<rss><channel><item><title>Good</title><link>https://nobsbitcoin.com/a/?utm_source=x&amp;keep=1#x</link><description><![CDATA[<script>ignore</script><p>Text</p>]]></description><pubDate>2026-09-09T00:00:00Z</pubDate></item><item><title>Bad</title><link>https://evil.example/a</link><pubDate>2026-09-09T00:00:00Z</pubDate></item></channel></rss>`;
    const result = await discoverNews({ fixtures: { ...(await fixtures()), nobsbitcoin: xml }, limit: 2, now: new Date("2026-09-10T00:00:00.000Z") });
    expect(result.accepted.map((item) => item.canonicalValue)).toContain("https://nobsbitcoin.com/a?keep=1");
    expect(result.rejected.some((item) => item.reason.includes("outside publication host"))).toBe(true);
  });

  it.each([
    ["doctype", "<!DOCTYPE rss><rss><channel><item/></channel></rss>"],
    ["entity", "<!ENTITY x 'bad'><rss><channel><item/></channel></rss>"],
    ["unterminated cdata", "<rss><channel><item><title><![CDATA[bad</title></item></channel></rss>"],
  ])("rejects hostile XML: %s", (_, xml) => {
    expect(() => parseNewsFeed(xml, NEWS_FEEDS[0]!)).toThrow();
  });

  it("bounds hostile item volume and records malformed item rejection", () => {
    const malformed = `<rss><channel><item><title>missing link</title><pubDate>2026-09-09</pubDate></item><item><title>ok</title><link>https://nobsbitcoin.com/ok</link><pubDate>2026-09-09</pubDate></item></channel></rss>`;
    const parsed = parseNewsFeed(malformed, NEWS_FEEDS[0]!);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.rejected[0]?.reason).toBe("missing-link");
    const hostile = `<rss><channel>${"<item><title>x</title></item>".repeat(20_001)}</channel></rss>`;
    expect(() => parseNewsFeed(hostile, NEWS_FEEDS[0]!)).toThrow(/item limit|element limit/);
  });

  it("selects recent items round-robin across feeds", async () => {
    const feedFixtures = Object.fromEntries(NEWS_FEEDS.map((feed) => [
      feed.id,
      feed.format === "atom"
        ? `<feed><entry><title>${feed.id}</title><link href="https://${feed.host}/item" /><published>2026-09-09T00:00:00Z</published></entry></feed>`
        : `<rss><channel><item><title>${feed.id}</title><link>https://${feed.host}/item</link><pubDate>2026-09-09T00:00:00Z</pubDate></item></channel></rss>`,
    ]));
    const result = await discoverNews({ fixtures: feedFixtures, limit: 6, now: new Date("2026-09-10T00:00:00.000Z") });
    expect(result.accepted.map((item) => new URL(item.displayValue).hostname)).toEqual(NEWS_FEEDS.map((feed) => feed.host));
  });

  it("fails closed on an unavailable feed and refuses publish and reconcile before homeserver calls", async () => {
    const fetchImpl: typeof fetch = async () => new Response("down", { status: 500 });
    const directory = `/tmp/jeb-n4/news-test-${process.pid}`;
    await mkdir(directory, { recursive: true });
    try {
      const cfg = configFromProcessEnv({ requireSecret: false, role: "resources" });
      cfg.homeserverPk = "ufibwbmed6jeq9k4p583go95wofakh9fwpp4k734trq79pd9u1uy";
      const run = await discoverNews({ limit: 1, fetchImpl });
      expect(run.shadowReport.halt).toEqual({ reason: "source-unavailable" });
      const stamp = { configVersion: RESOURCE_CONFIG_VERSION, gitHead: "test", sourceHash: await sourceTreeHash() };
      const stampPath = join(directory, "build-stamp.json");
      await writeFile(stampPath, JSON.stringify(stamp));
      const transport = {
        botPk: "test",
        putJson: async () => { throw new Error("homeserver must not be called"); },
        putBytes: async () => {},
        getJson: async () => { throw new Error("homeserver must not be called"); },
        deleteJson: async () => {},
        listPosts: async () => [],
        reauth: async () => {},
      };
      for (const mode of ["publish", "reconcile"] as const) {
        await expect(runResourcesCli(cfg, ["node", "main.js", "--role", "resources", "--source", "news", "--mode", mode, "--target", "staging", "--limit", "1", ...(mode === "reconcile" ? ["--reconcile", "full", "--expected-pk", "ui8nw8s9do7u9k9qts4cbup9ry6agz3wxmr734ddhk6jb6zcubso"] : [])], {
          fetchImpl,
          transport,
          buildStampPath: stampPath,
          gitHead: "test",
        })).rejects.toThrow("refused: source-unavailable");
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("halts before parsing when the read-time byte cap is exceeded", async () => {
    const oversized = new Uint8Array(NEWS_MAX_BODY_BYTES + 1);
    const fetchImpl: typeof fetch = async () => new Response(oversized, {
      status: 200,
      headers: { "content-type": "application/rss+xml" },
    });
    const result = await discoverNews({ limit: 1, fetchImpl });
    expect(result.shadowReport.halt?.reason).toBe("nobsbitcoin-truncated");
  });

  it("counts every feed request and halts at the request ceiling", async () => {
    const cacheDir = `/tmp/jeb-n4/request-cache-${process.pid}`;
    await rm(cacheDir, { recursive: true, force: true });
    resetFetchState();
    let calls = 0;
    const result = await discoverNews({
      limit: 1,
      feeds: NEWS_FEEDS.slice(0, 2),
      requestBudget: 1,
      fetchImpl: async () => new Response("down", { status: calls++ === 0 ? 404 : 500 }),
      cacheDir,
    });
    await rm(cacheDir, { recursive: true, force: true });
    expect(result.shadowReport.requests).toBe(2);
    expect(result.shadowReport.halt).toEqual({ reason: "request-budget-exhausted" });
  });

  it("refuses a limit above the hard cap", async () => {
    await expect(discoverNews({ limit: 101, fixtures: await fixtures() })).rejects.toThrow("1 to 100");
  });
});
