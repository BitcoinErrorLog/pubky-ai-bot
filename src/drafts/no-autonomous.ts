import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Source files that may set draft status to published. */
export const PUBLISH_STATUS_ALLOWLIST = ["db.ts", "db.js"];

function resolveDraftsDir(from = HERE): string {
  const candidates = [from, path.resolve(from, "../../src/drafts"), path.resolve(process.cwd(), "src/drafts")];
  return candidates.find((d) => existsSync(path.join(d, "finish.ts"))) ?? from;
}

/**
 * Writes of status=published (SQL SET or JS object literal). WHERE/FILTER
 * reads of published rows are allowed — they are not a publish path.
 */
const FORBIDDEN_PUBLISH_WRITE = /SET\s+status\s*=\s*['"]published['"]|status\s*:\s*['"]published['"]/;

export function assertNoAutonomousDraftPublish(srcRoot?: string): void {
  const draftsDir = resolveDraftsDir();
  const root = srcRoot ?? path.join(draftsDir, "..");
  const names = readdirSync(draftsDir).filter((f) => !f.startsWith("._"));
  const scanned = names
    .filter((f) => (existsSync(path.join(draftsDir, "finish.ts")) ? f.endsWith(".ts") : f.endsWith(".js")))
    .map((f) => path.join(draftsDir, f));
  if (scanned.length === 0) {
    throw new Error("no-autonomous: drafts directory produced an empty scan list");
  }
  for (const file of scanned) {
    const text = readFileSync(file, "utf8");
    if (FORBIDDEN_PUBLISH_WRITE.test(text)) {
      throw new Error(`autonomous publish path in ${path.basename(file)}`);
    }
  }
  const dbTs = path.join(root, "db.ts");
  const dbJs = path.join(root, "db.js");
  const dbPath = existsSync(dbTs) ? dbTs : dbJs;
  const db = readFileSync(dbPath, "utf8");
  if (!db.includes("markDraftPublished")) {
    throw new Error("db.ts must own markDraftPublished");
  }
  if (!db.includes("decided_by") || !db.includes("approved")) {
    throw new Error("markDraftPublished must require an approved row with decided_by");
  }
}
