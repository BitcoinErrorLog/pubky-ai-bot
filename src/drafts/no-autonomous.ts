import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DRAFTS_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Source files that may set draft status to published. */
export const PUBLISH_STATUS_ALLOWLIST = ["db.ts"];

export function assertNoAutonomousDraftPublish(srcRoot = path.join(DRAFTS_DIR, "..")): void {
  const files = [
    path.join(DRAFTS_DIR, "cli.ts"),
    path.join(DRAFTS_DIR, "generate.ts"),
    path.join(DRAFTS_DIR, "publish-request.ts"),
    path.join(DRAFTS_DIR, "what-changed.ts"),
    path.join(DRAFTS_DIR, "thread-worth-reading.ts"),
    path.join(DRAFTS_DIR, "the-disagreement.ts"),
    path.join(DRAFTS_DIR, "new-connection.ts"),
    path.join(DRAFTS_DIR, "pubky-explained.ts"),
    path.join(DRAFTS_DIR, "release-radar.ts"),
    path.join(DRAFTS_DIR, "finish.ts"),
  ];
  const forbidden = /status\s*[:=]\s*['"]published['"]/;
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (forbidden.test(text)) {
      throw new Error(`autonomous publish path in ${path.basename(file)}`);
    }
  }
  const db = readFileSync(path.join(srcRoot, "db.ts"), "utf8");
  if (!db.includes("markDraftPublished")) {
    throw new Error("db.ts must own markDraftPublished");
  }
  if (!db.includes("decided_by") || !db.includes("approved")) {
    throw new Error("markDraftPublished must require an approved row with decided_by");
  }
}
