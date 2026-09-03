import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { DatabaseMigrator } from "../infrastructure/database/migrator.js";
import { embedderFromEnv } from "./embed.js";
import { emptyMetrics, ingestSource } from "./ingest.js";
import { loadManifest } from "./manifest.js";
import { KnowledgeStore } from "./store.js";

export interface KnowledgeIngestReport {
  wall_ms: number;
  ingest: ReturnType<typeof emptyMetrics>;
  db: {
    sources: number;
    documents: number;
    chunks: number;
    refusals: number;
    refusal_rules: Record<string, number>;
    size_bytes: number;
  };
}

export function defaultManifestPath(): string {
  const fromEnv = process.env.JEB_SOURCES_YAML?.trim();
  if (fromEnv) return fromEnv;
  const fromCwd = path.join(process.cwd(), "sources.yaml");
  if (existsSync(fromCwd)) return fromCwd;
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "../../sources.yaml");
}

export async function runKnowledgeIngest(opts: {
  databaseUrl: string;
  full: boolean;
  sourceFilter?: string;
  manifestPath?: string;
}): Promise<{ ok: true; report: KnowledgeIngestReport } | { ok: false; error: string }> {
  const started = Date.now();
  const manifestPath = opts.manifestPath ?? defaultManifestPath();
  let entries;
  try {
    const manifest = loadManifest(manifestPath);
    entries = opts.sourceFilter ? manifest.sources.filter((s) => s.id === opts.sourceFilter) : manifest.sources;
  } catch (e) {
    return { ok: false, error: String(e) };
  }
  if (opts.sourceFilter && entries.length === 0) {
    return { ok: false, error: `unknown source ${opts.sourceFilter}` };
  }

  const pool = new pg.Pool({ connectionString: opts.databaseUrl, max: 8 });
  try {
    if (process.env.JEB_SKIP_MIGRATIONS !== "1") {
      await new DatabaseMigrator(pool).runMigrations();
    }
    const store = new KnowledgeStore(pool);
    const embedder = embedderFromEnv();
    const metrics = emptyMetrics();
    for (const entry of entries) {
      await ingestSource(store, entry, embedder, { full: opts.full, metrics });
    }
    if (opts.full && !opts.sourceFilter) {
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
    const report: KnowledgeIngestReport = {
      wall_ms: Date.now() - started,
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
    return { ok: true, report };
  } catch (e) {
    return { ok: false, error: String(e) };
  } finally {
    await pool.end();
  }
}
