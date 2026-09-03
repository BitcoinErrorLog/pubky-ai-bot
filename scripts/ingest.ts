#!/usr/bin/env npx tsx
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { DatabaseMigrator } from "../src/infrastructure/database/migrator.js";
import { embedderFromEnv } from "../src/knowledge/embed.js";
import { emptyMetrics, ingestSource } from "../src/knowledge/ingest.js";
import { loadManifest } from "../src/knowledge/manifest.js";
import { KnowledgeStore } from "../src/knowledge/store.js";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("-")) return process.argv[i + 1];
  return undefined;
}

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "sources.yaml");
const sourceFilter = argValue("--source");
const full = process.argv.includes("--full");
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const started = Date.now();
const manifest = loadManifest(manifestPath);
const entries = sourceFilter ? manifest.sources.filter((s) => s.id === sourceFilter) : manifest.sources;
if (sourceFilter && entries.length === 0) {
  console.error(`unknown source ${sourceFilter}`);
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url, max: 8 });
await new DatabaseMigrator(pool).runMigrations();
const store = new KnowledgeStore(pool);
const embedder = embedderFromEnv();
const metrics = emptyMetrics();
for (const entry of entries) {
  await ingestSource(store, entry, embedder, { full, metrics });
}
if (full && !sourceFilter) {
  const ids = entries.map((e) => e.id);
  await pool.query("DELETE FROM knowledge_sources WHERE NOT (id = ANY($1::text[]))", [ids]);
}
const counts = await pool.query<{
  sources: string;
  documents: string;
  chunks: string;
  refusals: string;
}>(
  `SELECT
     (SELECT COUNT(*)::text FROM knowledge_sources) AS sources,
     (SELECT COUNT(*)::text FROM knowledge_documents) AS documents,
     (SELECT COUNT(*)::text FROM knowledge_chunks) AS chunks,
     (SELECT COUNT(*)::text FROM knowledge_refusals) AS refusals`,
);
const rules = await pool.query<{ rule: string; n: string }>(
  `SELECT rule, COUNT(*)::text AS n FROM knowledge_refusals GROUP BY rule ORDER BY rule`,
);
const size = await pool.query<{ bytes: string }>(
  `SELECT pg_database_size(current_database())::text AS bytes`,
);
await pool.end();
const wallMs = Date.now() - started;
const report = {
  wall_ms: wallMs,
  ingest: metrics,
  db: {
    sources: Number(counts.rows[0].sources),
    documents: Number(counts.rows[0].documents),
    chunks: Number(counts.rows[0].chunks),
    refusals: Number(counts.rows[0].refusals),
    refusal_rules: Object.fromEntries(rules.rows.map((r) => [r.rule, Number(r.n)])),
    size_bytes: Number(size.rows[0].bytes),
  },
};
console.log(JSON.stringify(report, null, 2));
