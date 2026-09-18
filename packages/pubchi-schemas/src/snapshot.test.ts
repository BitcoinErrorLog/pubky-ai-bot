import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { snapshotProjection, snapshotSha256 } from "./snapshot.js";

type SnapshotFixture = {
  input: {
    target: Parameters<typeof snapshotProjection>[0];
    post: Parameters<typeof snapshotProjection>[1];
    user: Parameters<typeof snapshotProjection>[2];
  };
  projection: Record<string, string | null>;
  snapshot_sha256: string;
};

const fixtureDir = join(process.cwd(), "packages/pubchi-schemas/fixtures/snapshot");
const fixtureFiles = readdirSync(fixtureDir).filter((file) => file.endsWith(".json")).sort();

describe("snapshot projection fixtures", () => {
  it("has the complete shared fixture set", () => {
    expect(fixtureFiles).toEqual([
      "MANIFEST.json",
      "post__author-fallback.json",
      "post__basic.json",
      "post__missing-post-view.json",
      "post__unicode-content.json",
      "user__basic.json",
      "user__bio-null-vs-empty.json",
      "user__missing-user.json",
    ]);
  });

  for (const file of fixtureFiles.filter((name) => name !== "MANIFEST.json")) {
    it(`matches ${file}`, () => {
      const fixture = JSON.parse(readFileSync(join(fixtureDir, file), "utf8")) as SnapshotFixture;
      expect(snapshotProjection(fixture.input.target, fixture.input.post, fixture.input.user)).toEqual(fixture.projection);
      expect(snapshotSha256(fixture.projection)).toBe(fixture.snapshot_sha256);
    });
  }
});
