import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

async function sourceFiles(directory, prefix) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path, prefix));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(relative(prefix, path));
  }
  return files;
}

async function sourceTreeHash(root = process.cwd()) {
  const paths = [
    ...(await sourceFiles(join(root, "src"), root)),
    ...(await sourceFiles(join(root, "packages/bot-kit/src"), root)),
  ].sort();
  const hash = createHash("sha256");
  for (const path of paths) {
    hash.update(path);
    hash.update("\0");
    hash.update(await readFile(join(root, path)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

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
  sourceHash: await sourceTreeHash(),
  builtAt: new Date().toISOString(),
}, null, 2)}\n`);
