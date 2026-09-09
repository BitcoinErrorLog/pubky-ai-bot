import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const taxonomy = await readFile("dist/resource-taxonomy.js", "utf8");
const match = /RESOURCE_CONFIG_VERSION\s*=\s*"([^"]+)"/.exec(taxonomy);
if (!match) throw new Error("could not read RESOURCE_CONFIG_VERSION from dist/resource-taxonomy.js");

let gitHead = "unavailable";
try {
  gitHead = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() || "unavailable";
} catch {
  // A source archive can still be built without .git metadata.
}

await mkdir("dist", { recursive: true });
await writeFile("dist/build-stamp.json", `${JSON.stringify({
  configVersion: match[1],
  gitHead,
  builtAt: new Date().toISOString(),
}, null, 2)}\n`);
