import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  evalDatabaseUrl,
  isAnswerable,
  loadEvalQuestions,
  requiredSourceResolves,
  listIngestedUrls,
  runRetrievalEval,
} from "../../scripts/eval-lib.js";

const url = evalDatabaseUrl();

describe("eval corpus resolution and retrieval gate", () => {
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  const questions = loadEvalQuestions();

  beforeAll(async () => {
    const n = await pool.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM knowledge_chunks");
    expect(Number(n.rows[0].n)).toBeGreaterThanOrEqual(3000);
  }, 30_000);

  afterAll(async () => {
    await pool.end();
  });

  it("resolves every required_sources fragment to an ingested URL", async () => {
    const urls = await listIngestedUrls(pool);
    expect(urls.length).toBeGreaterThan(50);
    for (const q of questions) {
      for (const frag of q.required_sources) {
        expect(requiredSourceResolves(frag, urls), `${q.id} ${frag}`).toBe(true);
      }
    }
  });

  it("retrieves a required source in top-5 for at least 90% of answerable questions", async () => {
    const report = await runRetrievalEval(pool, questions);
    expect(report.answerableTotal).toBe(questions.filter(isAnswerable).length);
    expect(report.overallRate).toBeGreaterThanOrEqual(0.9);
  }, 600_000);
});
