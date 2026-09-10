import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/**
 * The stamp lives inside `dist` and records this hash, so it is excluded from
 * the hashed set — otherwise the value would depend on itself.
 */
export const BUILD_STAMP_BASENAME = "build-stamp.json";

/** Domain separator so a dist hash can never be confused with another digest. */
const DIST_HASH_DOMAIN = "jeb-dist-artifacts-v1";

/**
 * macOS filesystem metadata, not deployed artifacts: AppleDouble sidecars
 * (`._name`) and Finder state appear beside real files on non-APFS volumes,
 * are absent from the runtime image, and change without any rebuild. Hashing
 * them makes the stamp unverifiable on a developer machine while proving
 * nothing about the code Node loads. The suite excludes the same pattern
 * (`vitest.config.ts`).
 */
function isFilesystemMetadata(basename: string): boolean {
  return basename.startsWith("._") || basename === ".DS_Store";
}

async function artifactPaths(directory: string, root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const paths: string[] = [];
  for (const entry of entries) {
    if (isFilesystemMetadata(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...(await artifactPaths(path, root)));
    else if (entry.isFile()) paths.push(relative(root, path).split(sep).join("/"));
  }
  return paths;
}

/**
 * Hash of every shipped artifact under `distRoot`, in stable relative-path
 * order, path bytes included so a rename is a mismatch.
 *
 * This replaces hashing `src` + `packages/bot-kit/src`: the runtime image
 * copies `dist` and no TypeScript, so a source-tree hash can never match in
 * the image it is supposed to protect (`Dockerfile` runtime stage). Hashing
 * the deployed artifacts verifies exactly what Node executes.
 */
export async function distArtifactHash(distRoot: string): Promise<string> {
  const paths = (await artifactPaths(distRoot, distRoot))
    .filter((path) => path !== BUILD_STAMP_BASENAME)
    .sort();
  const hash = createHash("sha256");
  hash.update(`${DIST_HASH_DOMAIN}\0${paths.length}\0`);
  for (const path of paths) {
    hash.update(path);
    hash.update("\0");
    hash.update(await readFile(join(distRoot, path)));
    hash.update("\0");
  }
  return hash.digest("hex");
}
