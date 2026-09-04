import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Store } from "./db.js";
import {
  loadEvidenceLatency,
  loadIntentCounts,
  loadScoutToolCounts,
  loadWindowCounts,
  ratesFromCounts,
  tokensToUsd,
} from "./metrics-db.js";
import { fetchJebAccountSnapshot } from "./nexus-account.js";
import { Nexus } from "./nexus.js";

const url = process.env.DATABASE_URL ?? "postgres://johncarvalho@127.0.0.1:5432/jeb_stage1_test";
const BOT = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ASK = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function uri(author: string, id: string): string {
  return `pubky://${author}/pub/pubky.app/posts/${id}`;
}

const keys = {
  a: uri(ASK, "METRPUB000001"),
  b: uri(ASK, "METRPUB000002"),
  skip: uri(ASK, "METRSKIP00001"),
};

describe("tokensToUsd", () => {
  it("uses split in/out when present and output price for unsplit totals", () => {
    expect(tokensToUsd(1_000_000, 1_000_000, 2_000_000, 0.6, 2.5)).toBeCloseTo(3.1, 6);
    expect(tokensToUsd(0, 0, 1_000_000, 0.6, 2.5)).toBeCloseTo(2.5, 6);
  });
});

describe("metric queries against unit db", () => {
  let store: Store;
  beforeAll(async () => {
    store = new Store(url);
    await store.migrate();
    await store.pool.query("DELETE FROM corrections WHERE mention_key = ANY($1::text[])", [Object.values(keys)]);
    await store.pool.query("DELETE FROM scout_queries WHERE mention_key = ANY($1::text[])", [Object.values(keys)]);
    await store.pool.query("DELETE FROM evidence WHERE mention_key = ANY($1::text[])", [Object.values(keys)]);
    await store.pool.query("DELETE FROM handled_mentions WHERE mention_key = ANY($1::text[])", [Object.values(keys)]);
    const hourAgo = new Date(Date.now() - 3_600_000);
    await store.pool.query(
      `INSERT INTO handled_mentions (mention_key, status, author, bot_id, reply_uri, skip_reason, created_at)
       VALUES ($1, 'published', $4, $5, $6, NULL, $7),
              ($2, 'published', $4, $5, $8, NULL, $7),
              ($3, 'skipped', $4, $5, NULL, 'blocklist', $7)`,
      [keys.a, keys.b, keys.skip, ASK, BOT, uri(BOT, "METRRPLY00001"), hourAgo, uri(BOT, "METRRPLY00002")],
    );
    await store.pool.query(
      `INSERT INTO evidence (mention_key, intent, tool_trace, latency_ms) VALUES
       ($1, 'evidence_map', '[]'::jsonb, 100),
       ($2, 'answer', '[]'::jsonb, 300)`,
      [keys.a, keys.b],
    );
    await store.pool.query(
      `INSERT INTO scout_queries (tool, cypher_hash, params_hash, rows, truncated, duration_ms, ok, mention_key, created_at)
       VALUES ('trust_view', 'h', 'p', 2, false, 10, TRUE, $1, $2)`,
      [keys.a, hourAgo],
    );
    await store.pool.query(
      `INSERT INTO corrections (reply_uri, mention_key, reason, corrected_by, created_at)
       VALUES ($1, $2, 'fix', 'ops', $3)`,
      [uri(BOT, "METRRPLY00001"), keys.a, hourAgo],
    );
  });
  afterAll(async () => {
    await store.pool.query("DELETE FROM corrections WHERE mention_key = ANY($1::text[])", [Object.values(keys)]);
    await store.pool.query("DELETE FROM scout_queries WHERE mention_key = ANY($1::text[])", [Object.values(keys)]);
    await store.pool.query("DELETE FROM evidence WHERE mention_key = ANY($1::text[])", [Object.values(keys)]);
    await store.pool.query("DELETE FROM handled_mentions WHERE mention_key = ANY($1::text[])", [Object.values(keys)]);
    await store.close();
  });

  it("loads correction-loop counts for seeded rows", async () => {
    const since = new Date(Date.now() - 86_400_000);
    const counts = await loadWindowCounts(store.pool, since, Object.values(keys));
    expect(counts.publishedAnswers).toBe(2);
    expect(counts.acceptedMentions).toBe(2);
    expect(counts.corrections).toBe(1);
    expect(counts.uniqueInvokers).toBe(1);
    expect(counts.repeatAuthors).toBe(1);
    const rates = ratesFromCounts(counts, 7);
    expect(rates.correctionRate).toBeCloseTo(0.5, 6);
    expect(rates.repeatRate).toBeCloseTo(1, 6);
    expect(rates.successfulAnswerRate).toBeCloseTo(1, 6);
    const intents = await loadIntentCounts(store.pool, since, Object.values(keys));
    expect(intents).toEqual([
      { intent: "answer", count: 1 },
      { intent: "evidence_map", count: 1 },
    ]);
    const scout = await loadScoutToolCounts(store.pool, since, Object.values(keys));
    expect(scout).toEqual([{ tool: "trust_view", count: 1 }]);
    const lat = await loadEvidenceLatency(store.pool, since, Object.values(keys));
    expect(lat.sampleSize).toBe(2);
    expect(lat.p50).toBeCloseTo(200, 6);
  });
});

describe("Jeb account snapshot from Nexus", () => {
  it("parses followers, muted, and tags", async () => {
    const server: Server = await new Promise((resolve) => {
      const s = createServer((req, res) => {
        const u = new URL(req.url ?? "/", "http://127.0.0.1");
        res.writeHead(200, { "content-type": "application/json" });
        if (u.pathname.endsWith("/tags")) {
          res.end(JSON.stringify([{ label: "bot", taggers_count: 4 }]));
          return;
        }
        res.end(JSON.stringify({ counts: { followers: 11, following: 2, muted: 3 } }));
      });
      s.listen(0, "127.0.0.1", () => resolve(s));
    });
    const port = (server.address() as AddressInfo).port;
    try {
      const snap = await fetchJebAccountSnapshot(new Nexus(`http://127.0.0.1:${port}`), BOT);
      expect(snap.follows).toBe(11);
      expect(snap.following).toBe(2);
      expect(snap.muted).toBe(3);
      expect(snap.tags).toEqual([{ label: "bot", count: 4 }]);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
