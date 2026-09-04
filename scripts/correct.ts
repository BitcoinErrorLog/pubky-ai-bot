#!/usr/bin/env npx tsx
import { Store } from "../src/db.js";
import { exportUnexportedCorrections, insertCorrection, parseCorrectArgv } from "../src/corrections.js";
import { Nexus } from "../src/nexus.js";

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const args = parseCorrectArgv(process.argv.slice(2));
const store = new Store(url);
try {
  await store.migrate();
  if (args.exportEval) {
    const nexusUrl = process.env.JEB_NEXUS_URL?.trim() || "https://nexus.staging.pubky.app";
    const timeout = Number(process.env.JEB_NEXUS_TIMEOUT_MS ?? 10_000);
    const nexus = new Nexus(nexusUrl, Number.isFinite(timeout) ? timeout : 10_000);
    const result = await exportUnexportedCorrections(store.pool, args.exportEval, async (mentionKey) => {
      const post = await nexus.post(mentionKey);
      const content = post?.details.content?.trim();
      if (!content) {
        throw new Error(`could not fetch mention content from Nexus for ${mentionKey}`);
      }
      return content;
    });
    console.log(JSON.stringify({ exported: result.exportedIds, files: result.files }, null, 2));
    process.exit(0);
  }
  if (!args.reply || !args.reason || !args.by) {
    console.error("usage: npm run correct -- --reply <uri> --reason <text> --by <handle> [--correct-answer <text>]");
    console.error("       npm run correct -- --export-eval <dir>");
    process.exit(1);
  }
  const botPk = process.env.JEB_BOT_PK?.trim();
  if (!botPk) {
    console.error("JEB_BOT_PK is required");
    process.exit(1);
  }
  const row = await insertCorrection(store.pool, botPk, {
    replyUri: args.reply,
    reason: args.reason,
    correctedBy: args.by,
    correctAnswer: args.correctAnswer,
  });
  console.log(JSON.stringify({ ...row, created_at: row.created_at.toISOString(), exported_at: row.exported_at }, null, 2));
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
} finally {
  await store.close();
}
