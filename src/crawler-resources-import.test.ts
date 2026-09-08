import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const requiredIds: string[] = [];

vi.mock("node:module", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:module")>();
  return {
    ...actual,
    createRequire(filename: string | URL) {
      const req = actual.createRequire(filename);
      return (id: string) => {
        requiredIds.push(id);
        return req(id);
      };
    },
  };
});

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("crawler corpus sqlite loading", () => {
  it("does not require node:sqlite when the adapter module is imported", async () => {
    requiredIds.length = 0;
    await import("./crawler-resources.js");
    expect(requiredIds).not.toContain("node:sqlite");
  });

  it("requires node:sqlite only when opening a corpus database", async () => {
    const { discoverCrawlerResources } = await import("./crawler-resources.js");
    const directory = await mkdtemp(join(tmpdir(), "jeb-crawler-import-"));
    directories.push(directory);
    const path = join(directory, "not-a-sqlite.db");
    await writeFile(path, "not sqlite");

    requiredIds.length = 0;
    await expect(
      discoverCrawlerResources({ dbPath: path, source: "direct", labels: ["documentation"] }),
    ).rejects.toThrow();
    expect(requiredIds).toContain("node:sqlite");
  });
});
