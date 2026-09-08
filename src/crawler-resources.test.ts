import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverCrawlerResources } from "./crawler-resources.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): { run(...parameters: unknown[]): unknown };
    close(): void;
  };
};

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(
  rows: Array<{ url: unknown; title?: unknown; source?: string }>,
  schema = true,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "jeb-crawler-resources-"));
  directories.push(directory);
  const path = join(directory, "webindex.db");
  const database = new DatabaseSync(path);
  if (schema) {
    database.exec(`
      CREATE TABLE urls (
        url TEXT PRIMARY KEY,
        post_id TEXT,
        title TEXT,
        description TEXT,
        image_url TEXT,
        site_name TEXT,
        domain TEXT,
        language TEXT,
        published_at TEXT,
        source TEXT
      )
    `);
    const insert = database.prepare("INSERT INTO urls (url, title, source) VALUES (?, ?, ?)");
    for (const row of rows) insert.run(row.url, row.title ?? null, row.source ?? "direct");
  } else {
    database.exec("CREATE TABLE urls (url TEXT PRIMARY KEY)");
  }
  database.close();
  return path;
}

describe("crawler corpus resource adapter", () => {
  it("converts a selected slice with explicit labels and corpus provenance", async () => {
    const path = await fixture([
      { url: "https://bitcoin.org/", title: "Bitcoin", source: "direct" },
      { url: "https://bitcoinops.org/en/newsletters/1", title: null, source: "direct" },
      { url: "https://example.test/other", title: "Not selected", source: "bluesky" },
    ]);

    const result = await discoverCrawlerResources({
      dbPath: path,
      source: "direct",
      labels: ["documentation", "release"],
    });

    expect(result.accepted).toHaveLength(2);
    expect(result.accepted[0]).toMatchObject({
      labels: ["bitcoin"],
      title: "Bitcoin",
      provenance: { source: "web-index-direct" },
    });
    expect(result.accepted[1]?.title).toBeUndefined();
    expect(result.rejected).toHaveLength(0);
  });

  it("fails closed with the selected count above the cap", async () => {
    const path = await fixture(
      Array.from({ length: 101 }, (_, index) => ({ url: `https://example.test/${index}` })),
    );

    await expect(
      discoverCrawlerResources({ dbPath: path, source: "direct", labels: ["documentation"] }),
    ).rejects.toThrow("selection contains 101 records; maximum is 100");
  });

  it("does not let a smaller output limit drop selected rows", async () => {
    const path = await fixture([
      { url: "https://example.test/one" },
      { url: "https://example.test/two" },
    ]);

    await expect(
      discoverCrawlerResources({ dbPath: path, source: "direct", labels: ["documentation"], limit: 1 }),
    ).rejects.toThrow("contains 2 records but limit is 1; refusing to drop rows");
  });

  it("reports malformed and unsafe rows with discovery reasons", async () => {
    const path = await fixture([
      { url: "https://bitcoin.org/", title: "Good" },
      { url: "http://127.0.0.1/private", title: "Private" },
      { url: "https://pubky.app/docs", title: "Production" },
      { url: 42, title: "Malformed" },
    ]);

    const result = await discoverCrawlerResources({
      dbPath: path,
      source: "direct",
      labels: ["documentation"],
    });

    expect(result.accepted).toHaveLength(1);
    expect(result.rejected.map((item) => item.reason).sort()).toEqual([
      "invalid URL",
      "production target is not allowed",
      "unsafe URL protocol",
    ]);
    expect(result.accepted.length + result.rejected.length).toBe(4);
  });

  it("reports a malformed title without dropping its row", async () => {
    const path = await fixture([{ url: "https://example.test/docs", title: Buffer.from("malformed") }]);
    const result = await discoverCrawlerResources({
      dbPath: path,
      source: "direct",
      labels: ["documentation"],
    });
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toBe("invalid resource record");
  });

  it("fails clearly for a missing database", async () => {
    await expect(
      discoverCrawlerResources({
        dbPath: "/tmp/jeb-crawler-resource-database-does-not-exist",
        source: "direct",
        labels: ["documentation"],
      }),
    ).rejects.toThrow("ENOENT");
  });

  it("fails clearly for the wrong schema", async () => {
    const path = await fixture([], false);
    await expect(
      discoverCrawlerResources({ dbPath: path, source: "direct", labels: ["documentation"] }),
    ).rejects.toThrow("schema is missing urls columns");
  });

  it("requires an explicit database and source but not labels", async () => {
    await expect(
      discoverCrawlerResources({ dbPath: "", source: "direct", labels: ["documentation"] }),
    ).rejects.toThrow("requires --db");
    await expect(
      discoverCrawlerResources({ dbPath: "/tmp/unused", source: "", labels: ["documentation"] }),
    ).rejects.toThrow("requires --source");
    const path = await fixture([{ url: "https://bitcoin.org/", source: "direct" }]);
    await expect(discoverCrawlerResources({ dbPath: path, source: "direct", labels: [] })).resolves.toMatchObject({
      accepted: expect.any(Array),
    });
  });
});
