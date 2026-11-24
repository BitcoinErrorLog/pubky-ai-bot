import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildPost, buildUri, decodeObject } from "pubky-social-specs";
import { setClock } from "pubky-social-specs/testing";
import { describe, expect, it } from "vitest";
import { TEST_OWNER } from "./vectors.js";
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
  it("matches the App's Social v1 hash of the decoded post and versionless target", () => {
    setClock(() => 1_800_000_000_000);
    try {
      const post = buildPost(TEST_OWNER, { content: "A public post." });
      const uri = buildUri(TEST_OWNER, "post", post.id);
      const source = decodeObject(post.url, post.body, "post");
      const projection = snapshotProjection({ kind: "post", author: TEST_OWNER, uri }, { details: source }, null);
      expect(projection).toEqual({ kind: "post", uri, author: TEST_OWNER, content: "A public post.", post_kind: "note" });
      expect(snapshotSha256(projection)).toBe("758720484c8ee4c4eb7ee19529b6e4ce5c8120d5bd84df5c103e746909af4f77");
    } finally {
      setClock();
    }
  });

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
