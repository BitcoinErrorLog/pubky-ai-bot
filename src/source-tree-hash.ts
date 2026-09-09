import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

async function sourceFiles(directory: string, prefix: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await sourceFiles(path, prefix));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(relative(prefix, path));
    }
  }
  return files;
}

export async function sourceTreeHash(root = process.cwd()): Promise<string> {
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
