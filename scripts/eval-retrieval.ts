#!/usr/bin/env npx tsx
import pg from "pg";
import { evalDatabaseUrl, formatRetrievalTable, loadEvalQuestions, runRetrievalEval } from "./eval-lib.js";

const url = evalDatabaseUrl();
const questions = loadEvalQuestions();
const pool = new pg.Pool({ connectionString: url, max: 4 });
try {
  const n = await pool.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM knowledge_chunks");
  if (Number(n.rows[0]?.n ?? 0) < 3000) {
    console.error(
      `knowledge corpus too small in ${url} (${n.rows[0]?.n} chunks). Run: DATABASE_URL=${url} npm run ingest -- --full`,
    );
    process.exit(1);
  }
  const report = await runRetrievalEval(pool, questions);
  console.log(formatRetrievalTable(report));
  if (report.failures.length) {
    console.log("\nFailed retrieval (id + missing source fragments):");
    for (const f of report.failures) {
      console.log(`- ${f.id}: ${f.missing.join(" | ") || "(no required source in top-5)"}`);
    }
  } else {
    console.log("\nNo retrieval failures on answerable questions.");
  }
  console.log(`\nOverall answerable retrieval: ${(report.overallRate * 100).toFixed(1)}% (gate ≥ 90%)`);
  console.log(
    `Historical top-status historical/deprecated: ${(report.historicalRate * 100).toFixed(1)}% (${report.historicalOk}/${report.historicalChecked})`,
  );
  if (report.overallRate < 0.9) process.exit(2);
} finally {
  await pool.end();
}
