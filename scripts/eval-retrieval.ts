#!/usr/bin/env npx tsx
import pg from "pg";
import {
  evalDatabaseUrl,
  formatRetrievalTable,
  isAnswerable,
  loadEvalQuestions,
  runRetrievalEval,
  sourceFragmentMatches,
} from "./eval-lib.js";
import { embedderFromEnv } from "../src/knowledge/embed.js";
import { extraTsquery } from "../src/knowledge/query.js";
import { retrieveKnowledge } from "../src/knowledge/retrieve.js";
import { KnowledgeStore } from "../src/knowledge/store.js";

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

  if (process.argv[2] === "--explain") {
    const id = process.argv[3];
    if (!id) {
      console.error("usage: eval-retrieval.ts --explain <id>");
      process.exit(1);
    }
    const q = questions.find((x) => x.id === id);
    if (!q) {
      console.error(`unknown question id ${id}`);
      process.exit(1);
    }
    const store = new KnowledgeStore(pool);
    const embedder = embedderFromEnv();
    const t0 = Date.now();
    const result = await retrieveKnowledge(store, embedder, q.question, { k: 10, explain: true });
    const ms = Date.now() - t0;
    console.log(`id: ${id}`);
    console.log(`question: ${q.question}`);
    console.log(`required: ${q.required_sources.join(" | ")}`);
    console.log(`extra tsquery: ${extraTsquery(q.question) || "(none)"}`);
    console.log(`retrieve ms: ${ms}`);
    console.log("");
    console.log(
      [
        "rank".padEnd(5),
        "lex".padEnd(5),
        "vec".padEnd(5),
        "rrf".padEnd(8),
        "stW".padEnd(6),
        "kiW".padEnd(6),
        "score".padEnd(10),
        "status".padEnd(12),
        "kind".padEnd(18),
        "source",
      ].join(" "),
    );
    const rows = result.explain ?? [];
    for (const h of rows.slice(0, 10)) {
      console.log(
        [
          String(h.rank).padEnd(5),
          String(h.lexicalRank ?? "-").padEnd(5),
          String(h.vectorRank ?? "-").padEnd(5),
          h.rrf.toFixed(4).padEnd(8),
          h.statusWeight.toFixed(2).padEnd(6),
          h.kindWeight.toFixed(2).padEnd(6),
          h.score.toFixed(5).padEnd(10),
          h.status.padEnd(12),
          h.kind.padEnd(18),
          h.source_url ?? "",
        ].join(" "),
      );
    }
    console.log("");
    for (const frag of q.required_sources) {
      const hit = rows.find((h) => h.source_url && sourceFragmentMatches(h.source_url, frag));
      if (hit) {
        console.log(
          `required "${frag}" fused rank ${hit.rank} (lex ${hit.lexicalRank ?? "-"} vec ${hit.vectorRank ?? "-"}) ${hit.source_url}`,
        );
      } else {
        console.log(`required "${frag}" not in fused top-30`);
      }
    }
    const top5hit = result.chunks.slice(0, 5).some((c) =>
      q.required_sources.some((frag) => c.source_url && sourceFragmentMatches(c.source_url, frag)),
    );
    console.log(`top-5 required hit: ${top5hit}`);
    process.exit(0);
  }

  if (process.argv[2] === "--latency") {
    const store = new KnowledgeStore(pool);
    const embedder = embedderFromEnv();
    const answerable = questions.filter(isAnswerable);
    await retrieveKnowledge(store, embedder, answerable[0]?.question ?? "warmup", { k: 5 });
    const times: number[] = [];
    for (const q of answerable) {
      const t0 = performance.now();
      await retrieveKnowledge(store, embedder, q.question, { k: 5 });
      times.push(performance.now() - t0);
    }
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    times.sort((a, b) => a - b);
    const p95 = times[Math.min(times.length - 1, Math.floor(times.length * 0.95))];
    console.log(`search_knowledge warm latency n=${times.length} avg=${avg.toFixed(1)}ms p95=${p95.toFixed(1)}ms`);
    process.exit(0);
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
  const cats = Object.entries(report.perCategory).filter(([, s]) => s.total > 0 && s.rate < 0.8);
  if (cats.length) {
    console.log(`Categories below 80%: ${cats.map(([c, s]) => `${c} ${(s.rate * 100).toFixed(1)}%`).join(", ")}`);
  }
  if (report.overallRate < 0.9 || cats.length) process.exit(2);
  if (questions.filter(isAnswerable).length !== report.answerableTotal) process.exit(2);
} finally {
  await pool.end();
}
