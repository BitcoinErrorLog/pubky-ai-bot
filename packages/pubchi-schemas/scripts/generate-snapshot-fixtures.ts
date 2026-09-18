import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { snapshotProjection, snapshotSha256, type SnapshotTarget } from "../src/snapshot.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDir = join(root, "fixtures/snapshot");
mkdirSync(fixtureDir, { recursive: true });

const author = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const userUri = `pubky://${author}/pub/pubky.app/profile.json`;
const postUri = `pubky://${author}/pub/pubky.app/posts/ABC123DEF4567`;

const fixtures: Array<{
  name: string;
  target: SnapshotTarget;
  post: unknown;
  user: unknown;
}> = [
  {
    name: "post__basic.json",
    target: { kind: "post", uri: postUri, author },
    post: { details: { author, content: "A public post.", kind: "short" } },
    user: null,
  },
  {
    name: "post__missing-post-view.json",
    target: { kind: "post", uri: postUri, author },
    post: null,
    user: null,
  },
  {
    name: "post__unicode-content.json",
    target: { kind: "post", uri: postUri, author },
    post: { details: { author, content: "Café / Cafe\u0301 — שלום 👋", kind: "long" } },
    user: null,
  },
  {
    name: "post__author-fallback.json",
    target: { kind: "post", uri: postUri, author },
    post: { details: { content: "Missing author", kind: "short" } },
    user: null,
  },
  {
    name: "user__basic.json",
    target: { kind: "user", uri: userUri, pubky: author },
    post: null,
    user: { name: "Alice", bio: "A public profile." },
  },
  {
    name: "user__missing-user.json",
    target: { kind: "user", uri: userUri, pubky: author },
    post: null,
    user: null,
  },
  {
    name: "user__bio-null-vs-empty.json",
    target: { kind: "user", uri: userUri, pubky: author },
    post: null,
    user: { name: "Alice", bio: "" },
  },
];

for (const fixture of fixtures) {
  const projection = snapshotProjection(
    fixture.target,
    fixture.post as Parameters<typeof snapshotProjection>[1],
    fixture.user as Parameters<typeof snapshotProjection>[2],
  );
  writeFileSync(
    join(fixtureDir, fixture.name),
    `${JSON.stringify({ input: { target: fixture.target, post: fixture.post, user: fixture.user }, projection, snapshot_sha256: snapshotSha256(projection) }, null, 2)}\n`,
  );
}

const manifest = Object.fromEntries(
  readdirSync(fixtureDir)
    .filter((name) => name.endsWith(".json") && name !== "MANIFEST.json")
    .sort()
    .map((name) => [name, createHash("sha256").update(readFileSync(join(fixtureDir, name))).digest("hex")]),
);
writeFileSync(join(fixtureDir, "MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`);
