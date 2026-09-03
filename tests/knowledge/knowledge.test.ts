import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseMigrator } from "../../src/infrastructure/database/migrator.js";
import { chunkCode, chunkMarkdown } from "../../src/knowledge/chunker.js";
import { assertDimension, localEmbedder } from "../../src/knowledge/embed.js";
import { evaluateGate } from "../../src/knowledge/gate.js";
import { contentHash, emptyMetrics, ingestSource } from "../../src/knowledge/ingest.js";
import { parseManifest } from "../../src/knowledge/manifest.js";
import { retrieveKnowledge } from "../../src/knowledge/retrieve.js";
import { KnowledgeStore } from "../../src/knowledge/store.js";
import { searchKnowledgeParameters } from "../../src/tools.js";
import type { SourceEntry } from "../../src/knowledge/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "fixtures");
const KNOWLEDGE_TEST_DEFAULT = "postgres://johncarvalho@127.0.0.1:5432/jeb_knowledge_unit";

function knowledgeTestDatabaseUrl(): string {
  const url = process.env.JEB_KNOWLEDGE_TEST_DATABASE_URL?.trim() || KNOWLEDGE_TEST_DEFAULT;
  const bot = process.env.DATABASE_URL?.trim();
  const evalUrl = process.env.JEB_EVAL_DATABASE_URL?.trim();
  if (bot && url === bot) {
    throw new Error(
      "JEB_KNOWLEDGE_TEST_DATABASE_URL must not equal DATABASE_URL; knowledge tests truncate that database",
    );
  }
  if (evalUrl && url === evalUrl) {
    throw new Error(
      "JEB_KNOWLEDGE_TEST_DATABASE_URL must not equal JEB_EVAL_DATABASE_URL; knowledge tests truncate that database",
    );
  }
  return url;
}

const url = knowledgeTestDatabaseUrl();

describe("manifest parsing", () => {
  it("loads sources.yaml", () => {
    const text = fs.readFileSync(path.join(here, "../../sources.yaml"), "utf8");
    const m = parseManifest(text);
    expect(m.sources.length).toBeGreaterThan(5);
    expect(m.sources.every((s) => s.confidentiality === "public")).toBe(true);
    expect(m.sources.some((s) => s.id === "nexus-scout-llms")).toBe(true);
    expect(m.sources.some((s) => s.status === "historical" && s.product === "slashtags")).toBe(true);
  });

  it("rejects duplicate ids", () => {
    expect(() =>
      parseManifest(`sources:\n  - id: a\n    product: p\n    component: c\n    kind: local\n    location: /x\n    include: ["*"]\n    exclude: []\n    status: canonical\n    audience: user\n    confidentiality: public\n    owner: o\n  - id: a\n    product: p\n    component: c\n    kind: local\n    location: /x\n    include: ["*"]\n    exclude: []\n    status: canonical\n    audience: user\n    confidentiality: public\n    owner: o\n`),
    ).toThrow(/duplicate/);
  });
});

describe("confidentiality gate", () => {
  it("refuses internal strategy document fixture", () => {
    const p = path.join(fixtures, "internal-strategy.md");
    const text = fs.readFileSync(p, "utf8");
    const r = evaluateGate(p, text, "public");
    expect(r.ok).toBe(false);
    expect(r.rule).toBe("internal-strategy-document");
  });

  it("refuses annual reports, plans, and markers", () => {
    expect(evaluateGate("/x/annual reports/foo.md", "hi", "public").rule).toBe("annual-reports");
    expect(evaluateGate("/repo/.cursor/plans/jeb.md", "hi", "public").rule).toBe("cursor-plans");
    expect(evaluateGate("/x/arena-master-plan.md", "hi", "public").rule).toBe("filename-master-plan");
    expect(evaluateGate("/x/ok.md", "CONFIDENTIAL notes", "public").rule).toBe("confidential-marker");
    expect(evaluateGate("/x/ok.md", "See Synonym 2026 Budget", "public").rule).toBe("budget-marker");
    expect(evaluateGate("/x/blog-draft-x.md", "hi", "public").rule).toBe("blog-draft");
  });
});

describe("chunker", () => {
  it("splits markdown by heading", () => {
    const chunks = chunkMarkdown(fs.readFileSync(path.join(fixtures, "replies.md"), "utf8"));
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.some((c) => c.content.includes("Current"))).toBe(true);
    expect(chunks.some((c) => c.content.includes("History"))).toBe(true);
  });

  it("splits code by top-level item", () => {
    const chunks = chunkCode(fs.readFileSync(path.join(fixtures, "sample.ts"), "utf8"));
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });
});

describe("search_knowledge schema", () => {
  it("requires query", () => {
    expect(searchKnowledgeParameters.safeParse({}).success).toBe(false);
    expect(searchKnowledgeParameters.safeParse({ query: "ports" }).success).toBe(true);
    expect(searchKnowledgeParameters.safeParse({ query: "x", k: 3, product: "pubky-core" }).success).toBe(true);
  });
});

describe("postgres knowledge", () => {
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  const store = new KnowledgeStore(pool);
  const embedder = localEmbedder();

  beforeAll(async () => {
    await new DatabaseMigrator(pool).runMigrations();
    await pool.query("DELETE FROM knowledge_answer_evidence");
    await pool.query("DELETE FROM knowledge_chunks");
    await pool.query("DELETE FROM knowledge_documents");
    await pool.query("DELETE FROM knowledge_refusals");
    await pool.query("DELETE FROM knowledge_sources");
  }, 180_000);

  afterAll(async () => {
    await pool.end();
  });

  const fixtureSource = (id: string, status: SourceEntry["status"], dir: string): SourceEntry => ({
    id,
    product: "pubky-app-specs",
    component: "test",
    kind: "local",
    location: dir,
    include: ["*.md", "*.ts"],
    exclude: [],
    status,
    audience: "developer",
    confidentiality: "public",
    owner: "test",
    cite_base: "https://example.test/kb",
  });

  it("refuses internal strategy during ingest and counts it", async () => {
    const metrics = emptyMetrics();
    await ingestSource(store, fixtureSource("gate-src", "canonical", fixtures), embedder, { full: true, metrics });
    expect(metrics.refused).toBeGreaterThanOrEqual(1);
    expect(metrics.refusedByRule["internal-strategy-document"]).toBeGreaterThanOrEqual(1);
    const n = await pool.query("SELECT COUNT(*)::int AS n FROM knowledge_refusals WHERE rule = 'internal-strategy-document'");
    expect(n.rows[0].n).toBeGreaterThanOrEqual(1);
  }, 180_000);

  it("skips unchanged hashes on re-ingest", async () => {
    const dir = path.join(fixtures, "hashdir");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "a.md"), "# Title\n\nStable body about credible exit.\n");
    const src = fixtureSource("hash-src", "canonical", dir);
    const first = emptyMetrics();
    await ingestSource(store, src, embedder, { full: true, metrics: first });
    expect(first.documents).toBe(1);
    const second = emptyMetrics();
    await ingestSource(store, src, embedder, { full: false, metrics: second });
    expect(second.skippedUnchanged).toBe(1);
    expect(second.documents).toBe(0);
  }, 180_000);

  it("ranks canonical above historical for current questions and reverse for historical", async () => {
    const canonDir = path.join(fixtures, "canon");
    const histDir = path.join(fixtures, "hist");
    fs.mkdirSync(canonDir, { recursive: true });
    fs.mkdirSync(histDir, { recursive: true });
    fs.writeFileSync(
      path.join(canonDir, "reply.md"),
      "# Reply spec\n\nA pubky reply references its parent via the parent field on PubkyAppPost.\n",
    );
    fs.writeFileSync(
      path.join(histDir, "reply.md"),
      "# Old reply encoding\n\nOriginally Slashtags used a different parent encoding for replies. This is historical.\n",
    );
    await ingestSource(store, { ...fixtureSource("canon-reply", "canonical", canonDir), product: "specs" }, embedder, {
      full: true,
      metrics: emptyMetrics(),
    });
    await ingestSource(store, { ...fixtureSource("hist-reply", "historical", histDir), product: "slashtags" }, embedder, {
      full: true,
      metrics: emptyMetrics(),
    });
    const current = await retrieveKnowledge(store, embedder, "how does a pubky reply reference its parent", { k: 5 });
    expect(current.chunks[0]?.status).toBe("canonical");
    const historical = await retrieveKnowledge(store, embedder, "how did replies originally work in slashtags history", {
      k: 5,
    });
    expect(historical.chunks[0]?.status).toBe("historical");
  }, 180_000);

  it("errors on dimension mismatch", () => {
    expect(() => assertDimension(384, 768, "other-model")).toThrow(/dimension mismatch/);
    expect(() => assertDimension(null, 768, "other-model")).toThrow(/dimension mismatch/);
  });

  it("upsertSource rejects mixing dimensions", async () => {
    const entry = fixtureSource("dim-src", "canonical", fixtures);
    await store.upsertSource(entry, "Xenova/bge-small-en-v1.5", 384);
    await expect(store.upsertSource(entry, "other", 768)).rejects.toThrow(/dimension mismatch/);
  });
});

describe("hash helper", () => {
  it("is stable sha256", () => {
    expect(contentHash("abc")).toBe(createHash("sha256").update("abc").digest("hex"));
  });
});
