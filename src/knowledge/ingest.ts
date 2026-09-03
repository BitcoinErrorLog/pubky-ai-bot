import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chunkFile } from "./chunker.js";
import { assertDimension, type Embedder } from "./embed.js";
import { evaluateGate, logRefusal } from "./gate.js";
import { selectedByGlobs } from "./glob.js";
import { InjectionDetector } from "../injection-detector.js";
import { KnowledgeStore } from "./store.js";
import type { IngestMetrics, SourceEntry } from "./types.js";

const execFileAsync = promisify(execFile);

/** F-09: bounds for HTTP knowledge sources (hostile or broken endpoints). */
export const HTTP_SOURCE_MAX_BYTES = 2 * 1024 * 1024;
export const HTTP_SOURCE_TIMEOUT_MS = 30_000;

const HTTP_SOURCE_CONTENT_TYPE =
  /^(text\/|application\/(json|markdown|xml|x-yaml|yaml|javascript|typescript|x-sh))/;


export function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function walkDir(root: string): Promise<string[]> {
  const out: string[] = [];
  async function rec(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith("._")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === ".git" || e.name === "node_modules" || e.name === "target" || e.name === "dist") continue;
        await rec(full);
      } else if (e.isFile()) {
        out.push(full);
      }
    }
  }
  await rec(root);
  return out;
}

async function gitHead(dir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", dir, "rev-parse", "HEAD"]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function citeUrl(entry: SourceEntry, relPath: string): string | null {
  if (entry.kind === "http") return entry.location;
  if (entry.cite_base) return `${entry.cite_base.replace(/\/$/, "")}/${relPath.replaceAll("\\", "/")}`;
  return null;
}

const SKIP_EXT = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".ico",
  ".pdf",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".wasm",
  ".zip",
  ".gz",
  ".mp4",
  ".bin",
]);

export async function listSourceFiles(entry: SourceEntry): Promise<Array<{ path: string; rel: string }>> {
  if (entry.kind === "http") {
    return [{ path: entry.location, rel: entry.location }];
  }
  const files = await walkDir(entry.location);
  const picked: Array<{ path: string; rel: string }> = [];
  for (const full of files) {
    const rel = path.relative(entry.location, full);
    if (selectedByGlobs(rel, entry.include, entry.exclude)) {
      if (SKIP_EXT.has(path.extname(full).toLowerCase())) continue;
      picked.push({ path: full, rel });
    }
  }
  return picked;
}

export async function readSourceFile(
  entry: SourceEntry,
  filePath: string,
  opts?: { timeoutMs?: number; maxBytes?: number },
): Promise<{ text: string; version: string | null }> {
  if (entry.kind === "http") {
    const timeoutMs = opts?.timeoutMs ?? HTTP_SOURCE_TIMEOUT_MS;
    const maxBytes = opts?.maxBytes ?? HTTP_SOURCE_MAX_BYTES;
    const res = await fetch(filePath, {
      headers: { "user-agent": "jeb-knowledge-ingest/1.0" },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`http ${res.status} ${filePath}`);
    const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (contentType && !HTTP_SOURCE_CONTENT_TYPE.test(contentType)) {
      throw new Error(`http source content-type rejected: ${contentType}`);
    }
    const text = (await res.text()).replace(/\u0000/g, "");
    if (text.length > maxBytes) throw new Error(`http source too large (> ${maxBytes} bytes)`);
    const etag = res.headers.get("etag");
    const lastMod = res.headers.get("last-modified");
    return { text, version: etag ?? lastMod ?? new Date().toISOString() };
  }
  const raw = await fs.readFile(filePath, "utf8");
  const text = raw.replace(/\u0000/g, "");
  const version = await gitHead(entry.location);
  return { text, version };
}

export async function ingestSource(
  store: KnowledgeStore,
  entry: SourceEntry,
  embedder: Embedder,
  opts: { full: boolean; metrics: IngestMetrics },
): Promise<void> {
  if (entry.confidentiality !== "public") {
    opts.metrics.refused += 1;
    opts.metrics.refusedByRule["confidentiality-excluded"] =
      (opts.metrics.refusedByRule["confidentiality-excluded"] ?? 0) + 1;
    logRefusal(entry.location, "confidentiality-excluded");
    await store.recordRefusal(entry.id, entry.location, "confidentiality-excluded");
    return;
  }
  assertDimension(null, embedder.dim, embedder.modelId);
  const injectionDetector = new InjectionDetector();
  await store.upsertSource(entry, embedder.modelId, embedder.dim);
  opts.metrics.sources += 1;
  const files = await listSourceFiles(entry);
  const kept: string[] = [];
  for (const file of files) {
    const pathGate = evaluateGate(file.path, null, entry.confidentiality);
    if (!pathGate.ok && pathGate.rule) {
      opts.metrics.refused += 1;
      opts.metrics.refusedByRule[pathGate.rule] = (opts.metrics.refusedByRule[pathGate.rule] ?? 0) + 1;
      logRefusal(file.path, pathGate.rule);
      await store.recordRefusal(entry.id, file.path, pathGate.rule);
      continue;
    }
    let text: string;
    let version: string | null;
    try {
      ({ text, version } = await readSourceFile(entry, file.path));
    } catch (e) {
      logRefusal(file.path, "confidentiality-excluded");
      throw e;
    }
    const contentGate = evaluateGate(file.path, text, entry.confidentiality);
    if (!contentGate.ok && contentGate.rule) {
      opts.metrics.refused += 1;
      opts.metrics.refusedByRule[contentGate.rule] = (opts.metrics.refusedByRule[contentGate.rule] ?? 0) + 1;
      logRefusal(file.path, contentGate.rule);
      await store.recordRefusal(entry.id, file.path, contentGate.rule);
      continue;
    }
    const hash = contentHash(text);
    kept.push(file.rel);
    const existing = await store.getDocumentHash(entry.id, file.rel);
    if (!opts.full && existing === hash) {
      opts.metrics.skippedUnchanged += 1;
      continue;
    }
    const chunks = chunkFile(file.path, text);
    const embeddings = await embedder.embed(chunks.map((c) => c.content));
    const docId = await store.upsertDocument({
      sourceId: entry.id,
      path: file.rel,
      sourceUrl: citeUrl(entry, file.rel),
      version,
      contentHash: hash,
    });
    await store.replaceChunks(
      docId,
      chunks.map((c, i) => ({
        content: c.content,
        ordinal: c.ordinal,
        hash: contentHash(c.content),
        embedding: embeddings[i] ?? embeddings[0],
        metadata: {
          product: entry.product,
          component: entry.component,
          source_id: entry.id,
          path: file.rel,
          source_url: citeUrl(entry, file.rel),
          version,
          status: entry.status,
          audience: entry.audience,
          // F-03: the corpus is a stored injection vector. Flag chunks whose
          // content trips the detector; retrieval down-ranks them.
          suspect_injection: injectionDetector.detect(c.content).detected,
          ingested_at: new Date().toISOString(),
          content_hash: contentHash(c.content),
          chunk_kind: c.kind,
        },
      })),
    );
    opts.metrics.documents += 1;
    opts.metrics.chunks += chunks.length;
  }
  opts.metrics.deleted += await store.deleteMissingDocuments(entry.id, kept);
}

export function emptyMetrics(): IngestMetrics {
  return {
    sources: 0,
    documents: 0,
    chunks: 0,
    skippedUnchanged: 0,
    refused: 0,
    deleted: 0,
    refusedByRule: {},
  };
}
