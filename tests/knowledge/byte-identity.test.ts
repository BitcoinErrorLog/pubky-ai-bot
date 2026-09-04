import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseMigrator } from "../../src/infrastructure/database/migrator.js";
import { localEmbedder } from "../../src/knowledge/embed.js";
import { emptyMetrics, ingestSource } from "../../src/knowledge/ingest.js";
import { extraTsquery } from "../../src/knowledge/query.js";
import { retrieveKnowledge } from "../../src/knowledge/retrieve.js";
import { KnowledgeStore } from "../../src/knowledge/store.js";
import { extraTsquery as preMoveExtraTsquery } from "./pre-move/query.js";
import type { SourceEntry } from "../../src/knowledge/types.js";
import { retrieveKnowledge as preMoveRetrieve } from "./pre-move/retrieve.js";
import { KnowledgeStore as PreMoveStore } from "./pre-move/store.js";

const url =
  process.env.JEB_KNOWLEDGE_TEST_DATABASE_URL?.trim() || "postgres://johncarvalho@127.0.0.1:5432/jeb_kit11_knowledge_unit";

const QUERIES = [
  "how does a homeserver store the database",
  "what is the paykit protocol",
  "how did slashtags originally work historically",
  "bitkit-core uniffi python bindings",
  "session ttl revocation",
] as const;

function source(id: string, status: SourceEntry["status"], dir: string, extra?: Partial<SourceEntry>): SourceEntry {
  return {
    id,
    product: "pubky",
    component: "test",
    kind: "local",
    location: dir,
    include: ["*.md"],
    exclude: [],
    status,
    audience: "developer",
    confidentiality: "public",
    owner: "test",
    cite_base: `https://example.test/${id}`,
    ...extra,
  };
}

describe("knowledge retriever byte-identity vs pre-move", () => {
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  const kitStore = new KnowledgeStore(pool);
  const preStore = new PreMoveStore(pool);
  const embedder = localEmbedder();

  beforeAll(async () => {
    await new DatabaseMigrator(pool).runMigrations();
    await pool.query("DELETE FROM knowledge_answer_evidence");
    await pool.query("DELETE FROM knowledge_chunks");
    await pool.query("DELETE FROM knowledge_documents");
    await pool.query("DELETE FROM knowledge_refusals");
    await pool.query("DELETE FROM knowledge_sources WHERE id LIKE 'kit11-%'");

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jeb-kit11-"));
    const homeserver = path.join(root, "getting-started");
    const paykit = path.join(root, "paykit");
    const hist = path.join(root, "hist");
    const bitkit = path.join(root, "bitkit-core");
    const auth = path.join(root, "auth");
    fs.mkdirSync(homeserver, { recursive: true });
    fs.mkdirSync(paykit, { recursive: true });
    fs.mkdirSync(hist, { recursive: true });
    fs.mkdirSync(bitkit, { recursive: true });
    fs.mkdirSync(auth, { recursive: true });
    fs.writeFileSync(
      path.join(homeserver, "getting-started.md"),
      "# Homeserver database\n\nA homeserver stores posts in a local database. Operators configure the homeserver database path.\n",
    );
    fs.writeFileSync(
      path.join(paykit, "paykit_protocol.md"),
      "# Paykit protocol\n\nThe paykit protocol describes invoices, hops, and settlement between wallets.\n",
    );
    fs.writeFileSync(
      path.join(hist, "slashtags.md"),
      "# Slashtags history\n\nOriginally slashtags used a different identity encoding. This is historical.\n",
    );
    fs.writeFileSync(
      path.join(bitkit, "README.md"),
      "# bitkit-core\n\nUniFFI bindings expose create_order and python helpers for Blocktank.\n",
    );
    fs.writeFileSync(
      path.join(auth, "auth.md"),
      "# Session TTL\n\nSession ttl and revocation are controlled by the auth document.\n",
    );

    await ingestSource(
      kitStore,
      { ...source("kit11-homeserver", "canonical", homeserver), cite_base: "https://example.test/getting-started" },
      embedder,
      { full: true, metrics: emptyMetrics() },
    );
    await ingestSource(
      kitStore,
      { ...source("kit11-paykit", "canonical", paykit), cite_base: "https://example.test/paykit_protocol" },
      embedder,
      { full: true, metrics: emptyMetrics() },
    );
    await ingestSource(
      kitStore,
      { ...source("kit11-hist", "historical", hist), product: "slashtags", cite_base: "https://example.test/slashtags" },
      embedder,
      { full: true, metrics: emptyMetrics() },
    );
    await ingestSource(
      kitStore,
      {
        ...source("kit11-bitkit", "released", bitkit),
        product: "bitkit",
        cite_base: "https://github.com/synonymdev/bitkit-core/blob/main",
      },
      embedder,
      { full: true, metrics: emptyMetrics() },
    );
    await ingestSource(
      kitStore,
      { ...source("kit11-auth", "canonical", auth), cite_base: "https://example.test/auth.md" },
      embedder,
      { full: true, metrics: emptyMetrics() },
    );
  }, 180_000);

  afterAll(async () => {
    await pool.end();
  });

  it("expands the 5 queries identically to the pre-move tsquery helper", () => {
    for (const q of QUERIES) {
      expect(extraTsquery(q), q).toBe(preMoveExtraTsquery(q));
    }
  });

  it("returns identical ranked chunk ids for 5 fixed queries", async () => {
    for (const q of QUERIES) {
      const kit = await retrieveKnowledge(kitStore, embedder, q, { k: 8 });
      const pre = await preMoveRetrieve(preStore, embedder, q, { k: 8 });
      expect(kit.chunks.map((c) => c.id), q).toEqual(pre.chunks.map((c) => c.id));
      expect(kit.truncated, q).toBe(pre.truncated);
    }
  }, 180_000);
});
