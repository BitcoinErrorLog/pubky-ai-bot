import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILD_STAMP_BASENAME, distArtifactHash } from "./dist-artifact-hash.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

let directory = "";

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "jeb-dist-hash-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function seedDist(root: string): Promise<void> {
  await mkdir(join(root, "infrastructure/database/migrations"), { recursive: true });
  await writeFile(join(root, "main.js"), "console.log('jeb');\n");
  await writeFile(join(root, "resource-taxonomy.js"), 'export const RESOURCE_CONFIG_VERSION = "v1";\n');
  await writeFile(join(root, "infrastructure/database/migrations/110_resource_runs.sql"), "SELECT 1;\n");
}

describe("deployed dist artifact hash", () => {
  it("is stable across repeated hashing of the same artifact set", async () => {
    await seedDist(directory);
    const first = await distArtifactHash(directory);
    const second = await distArtifactHash(directory);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
  });

  it("ignores the build stamp it is written into", async () => {
    await seedDist(directory);
    const before = await distArtifactHash(directory);
    await writeFile(join(directory, BUILD_STAMP_BASENAME), JSON.stringify({ distHash: before }));
    expect(await distArtifactHash(directory)).toBe(before);
    await writeFile(join(directory, BUILD_STAMP_BASENAME), JSON.stringify({ distHash: "rewritten" }));
    expect(await distArtifactHash(directory)).toBe(before);
  });

  // Deliberate negative: one copied byte differs, so the runtime refuses.
  it("changes when a single deployed byte changes", async () => {
    await seedDist(directory);
    const before = await distArtifactHash(directory);
    await writeFile(join(directory, "main.js"), "console.log('jeb');\n\n");
    expect(await distArtifactHash(directory)).not.toBe(before);
  });

  // Deliberate negative: identical bytes at a different path must not pass.
  it("changes when an artifact is renamed without changing its bytes", async () => {
    await seedDist(directory);
    const before = await distArtifactHash(directory);
    await rename(join(directory, "main.js"), join(directory, "main-renamed.js"));
    expect(await distArtifactHash(directory)).not.toBe(before);
  });

  // Deliberate negative: a data artifact the build copies is in scope too.
  it("changes when a copied SQL migration changes", async () => {
    await seedDist(directory);
    const before = await distArtifactHash(directory);
    await writeFile(join(directory, "infrastructure/database/migrations/110_resource_runs.sql"), "SELECT 2;\n");
    expect(await distArtifactHash(directory)).not.toBe(before);
  });

  it("ignores macOS filesystem metadata that is absent from the image", async () => {
    await seedDist(directory);
    const before = await distArtifactHash(directory);
    await writeFile(join(directory, "._main.js"), "AppleDouble\n");
    await writeFile(join(directory, ".DS_Store"), "finder\n");
    await writeFile(join(directory, "infrastructure/database/._migrations"), "AppleDouble\n");
    expect(await distArtifactHash(directory)).toBe(before);
  });

  it("distinguishes a missing dist from a populated one", async () => {
    const empty = await distArtifactHash(join(directory, "absent"));
    await seedDist(directory);
    expect(await distArtifactHash(directory)).not.toBe(empty);
  });
});

describe("runtime image cannot satisfy a source-tree stamp", () => {
  it("ships dist and no TypeScript source, which is why the hash moved to dist", async () => {
    const dockerfile = await readFile(join(repoRoot, "Dockerfile"), "utf8");
    const runtime = dockerfile.slice(dockerfile.indexOf("AS runtime"), dockerfile.indexOf("AS pubchi"));
    expect(runtime).toContain("/app/dist ./dist");
    // The retired source-tree hash covered `src` and `packages/bot-kit/src`.
    // Neither is copied into the stage that runs publish/reconcile, so that
    // predicate was unsatisfiable in the image it was meant to protect.
    expect(runtime).not.toMatch(/COPY[^\n]*\/app\/src/);
    expect(runtime).not.toMatch(/COPY[^\n]*\/app\/packages/);
  });

  it("no runtime module hashes the TypeScript source tree any more", async () => {
    const resources = await readFile(join(repoRoot, "src/resources.ts"), "utf8");
    expect(resources).not.toContain("sourceTreeHash");
    expect(resources).toContain("distArtifactHash");
  });
});
