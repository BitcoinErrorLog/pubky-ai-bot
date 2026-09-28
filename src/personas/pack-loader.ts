import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { PersonaPackSchema, type PersonaPack } from "./schema.js";

export interface LoadedPersonaPack {
  pack: PersonaPack;
  packHash: string;
  packPath: string;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function hashPack(bytes: Buffer): string {
  const hash = createHash("sha256");
  hash.update("pack.yaml");
  hash.update("\0");
  hash.update(String(bytes.length));
  hash.update("\0");
  hash.update(bytes);
  hash.update("\0");
  return hash.digest("hex");
}

/** Identity-free loader: no account binding, keys, database, or Jeb tools. */
export function loadPersonaPack(packPath: string): LoadedPersonaPack {
  if (lstatSync(packPath).isSymbolicLink()) throw new Error(`persona packs cannot be symlinks: ${packPath}`);
  const bundleRoot = realpathSync(path.dirname(packPath));
  const realPackPath = realpathSync(packPath);
  if (path.dirname(realPackPath) !== bundleRoot || !statSync(realPackPath).isFile()) {
    throw new Error("persona pack must be a regular bundle file");
  }
  const hashPath = path.join(bundleRoot, "pack.snapshot.sha256");
  if (lstatSync(hashPath).isSymbolicLink() || !statSync(hashPath).isFile()) {
    throw new Error("persona pack hash must be a regular bundle file");
  }
  const bytes = readFileSync(realPackPath);
  let parsed: unknown;
  try {
    parsed = parseYaml(bytes.toString("utf8"), { maxAliasCount: 20, uniqueKeys: true });
  } catch (error) {
    throw new Error(`invalid persona pack YAML ${realPackPath}: ${String(error)}`);
  }
  const result = PersonaPackSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`invalid persona pack ${realPackPath}: ${issues}`);
  }
  const packHash = hashPack(bytes);
  const expected = readFileSync(hashPath, "utf8").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected) || expected !== packHash) {
    throw new Error(`persona pack ${result.data.id} hash mismatch`);
  }
  return deepFreeze({ pack: result.data, packHash, packPath: realPackPath });
}
