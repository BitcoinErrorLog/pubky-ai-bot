import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Single-sourced with the runtime verifier: the compiled hash function is the
// one the running artifact uses, so writer and checker cannot drift.
const { distArtifactHash } = await import("../dist/dist-artifact-hash.js");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = join(root, "dist");

const taxonomy = await readFile(join(distRoot, "resource-taxonomy.js"), "utf8");
const configVersion = /RESOURCE_CONFIG_VERSION\s*=\s*"([^"]+)"/.exec(taxonomy);
if (!configVersion) throw new Error("could not read RESOURCE_CONFIG_VERSION from dist/resource-taxonomy.js");

const profiles = await readFile(join(distRoot, "resource-target-profile.js"), "utf8");
const pinSetVersion = /RESOURCE_PIN_SET_VERSION\s*=\s*"([^"]+)"/.exec(profiles);
if (!pinSetVersion) throw new Error("could not read RESOURCE_PIN_SET_VERSION from dist/resource-target-profile.js");

let gitHead = "unavailable";
try {
  gitHead = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() || "unavailable";
} catch {
  // A source archive can still be built without .git metadata.
}

// The stamp carries no target: one immutable image serves every target and the
// run's target is validated at runtime against the compiled profile set.
await mkdir(distRoot, { recursive: true });
await writeFile(join(distRoot, "build-stamp.json"), `${JSON.stringify({
  configVersion: configVersion[1],
  pinSetVersion: pinSetVersion[1],
  gitHead,
  distHash: await distArtifactHash(distRoot),
  builtAt: new Date().toISOString(),
}, null, 2)}\n`);
