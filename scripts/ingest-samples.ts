import pg from "pg";
import { embedderFromEnv } from "../src/knowledge/embed.js";
import { retrieveKnowledge } from "../src/knowledge/retrieve.js";
import { KnowledgeStore } from "../src/knowledge/store.js";

const questions = [
  "how does a pubky reply reference its parent",
  "what ports does the static testnet use",
  "what is credible exit",
  "is Slashtags still used",
  "what does Nexus Scout return on /v1/query",
  "what is a pubky homeserver session",
  "how do tags work in pubky-app-specs",
  "what is Atomicity sealed blob",
  "what is Paykit payment discovery",
  "what is pkarr used for",
];

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL");
const pool = new pg.Pool({ connectionString: url, max: 4 });
const store = new KnowledgeStore(pool);
const embedder = embedderFromEnv();
const samples: unknown[] = [];
for (const q of questions) {
  const r = await retrieveKnowledge(store, embedder, q, { k: 3 });
  samples.push({
    query: q,
    top3: r.chunks.map((c) => ({
      source_url: c.source_url,
      product: c.product,
      status: c.status,
      score: Number(c.score.toFixed(4)),
    })),
  });
}
await pool.end();
console.log(JSON.stringify(samples, null, 2));
