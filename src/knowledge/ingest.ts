import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { chunkFile } from "./chunker.js";
import { assertDimension, type Embedder } from "./embed.js";
import { evaluateGate, logRefusal } from "./gate.js";
import { selectedByGlobs } from "./glob.js";
import { InjectionDetector } from "../injection-detector.js";
import { log } from "../log.js";
import { KnowledgeStore } from "./store.js";
import type { IngestMetrics, SourceEntry } from "./types.js";

const execFileAsync = promisify(execFile);

/** F-09: bounds for HTTP knowledge sources (hostile or broken endpoints). */
export const HTTP_SOURCE_MAX_BYTES = 2 * 1024 * 1024;
export const HTTP_SOURCE_TIMEOUT_MS = 30_000;

export const GIT_SOURCE_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/;
export const GIT_CLONE_TIMEOUT_MS = 60_000;
export const GIT_CLONE_MAX_BYTES = 200 * 1024 * 1024;

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

async function dirSizeBytes(root: string): Promise<number> {
  let total = 0;
  async function rec(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await rec(full);
      else if (e.isFile()) {
        const st = await fs.stat(full);
        total += st.size;
      }
    }
  }
  await rec(root);
  return total;
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

function validateGitLocation(location: string): string {
  const url = location.replace(/\.git$/, "").replace(/\/$/, "");
  if (!GIT_SOURCE_URL.test(url)) {
    throw new Error(`invalid git source url (expected https://github.com/owner/repo): ${location}`);
  }
  return url;
}

function sparsePaths(include: string[]): string[] {
  const paths = new Set<string>();
  for (const g of include) {
    const cleaned = g.replace(/^\.\//, "");
    if (cleaned === "**/*.md" || cleaned === "*.md") {
      paths.add("**/*.md");
      continue;
    }
    const noGlob = cleaned.replace(/\/\*\*$/, "").replace(/\/\*$/, "");
    if (noGlob && !noGlob.includes("*")) paths.add(noGlob);
    else paths.add(cleaned);
  }
  return [...paths];
}

export async function cloneGitSource(entry: SourceEntry): Promise<{ dir: string; sha: string }> {
  const url = validateGitLocation(entry.location);
  const ref = entry.ref?.trim();
  if (!ref) throw new Error(`git source ${entry.id} missing ref`);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeb-git-"));
  const args = ["clone", "--depth", "1", "--branch", ref, "--filter=blob:none", "--sparse", "--", url, dir];
  try {
    await execFileAsync("git", args, { timeout: GIT_CLONE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
    const sparse = sparsePaths(entry.include);
    if (sparse.length) {
      await execFileAsync("git", ["-C", dir, "sparse-checkout", "set", "--no-cone", ...sparse], {
        timeout: GIT_CLONE_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
      });
    }
    const size = await dirSizeBytes(dir);
    if (size > GIT_CLONE_MAX_BYTES) {
      throw new Error(`git clone exceeds ${GIT_CLONE_MAX_BYTES} bytes (${size}) for ${entry.id}`);
    }
    const sha = await gitHead(dir);
    if (!sha) throw new Error(`git clone produced no HEAD for ${entry.id}`);
    return { dir, sha };
  } catch (e) {
    await fs.rm(dir, { recursive: true, force: true });
    throw e;
  }
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

function skipLocal(entry: SourceEntry): "env" | "missing" | null {
  if (entry.kind !== "local") return null;
  if (process.env.JEB_SOURCES_SKIP_LOCAL === "1") return "env";
  return null;
}

async function localPathExists(location: string): Promise<boolean> {
  try {
    await fs.stat(location);
    return true;
  } catch {
    return false;
  }
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

  const localSkip = skipLocal(entry);
  if (localSkip === "env") {
    log.warn({ source: entry.id }, "skipping local knowledge source (JEB_SOURCES_SKIP_LOCAL)");
    opts.metrics.skippedMissingLocal += 1;
    return;
  }
  if (entry.kind === "local" && !(await localPathExists(entry.location))) {
    log.warn({ source: entry.id, path: entry.location }, "skipping missing local knowledge source");
    opts.metrics.skippedMissingLocal += 1;
    return;
  }

  let gitClone: { dir: string; sha: string } | null = null;
  let workEntry = entry;
  try {
    if (entry.kind === "git") {
      gitClone = await cloneGitSource(entry);
      workEntry = { ...entry, location: gitClone.dir };
    }
    await ingestResolvedSource(store, entry, workEntry, embedder, opts, gitClone?.sha ?? null);
  } finally {
    if (gitClone) await fs.rm(gitClone.dir, { recursive: true, force: true });
  }
}

async function ingestResolvedSource(
  store: KnowledgeStore,
  catalog: SourceEntry,
  filesRoot: SourceEntry,
  embedder: Embedder,
  opts: { full: boolean; metrics: IngestMetrics },
  gitSha: string | null,
): Promise<void> {
  assertDimension(null, embedder.dim, embedder.modelId);
  const injectionDetector = new InjectionDetector();
  await store.upsertSource(catalog, embedder.modelId, embedder.dim);
  opts.metrics.sources += 1;
  const files = await listSourceFiles(filesRoot);
  const kept: string[] = [];
  for (const file of files) {
    const pathGate = evaluateGate(file.path, null, catalog.confidentiality);
    if (!pathGate.ok && pathGate.rule) {
      opts.metrics.refused += 1;
      opts.metrics.refusedByRule[pathGate.rule] = (opts.metrics.refusedByRule[pathGate.rule] ?? 0) + 1;
      logRefusal(file.path, pathGate.rule);
      await store.recordRefusal(catalog.id, file.path, pathGate.rule);
      continue;
    }
    let text: string;
    let version: string | null;
    try {
      ({ text, version } = await readSourceFile(filesRoot, file.path));
    } catch (e) {
      logRefusal(file.path, "confidentiality-excluded");
      throw e;
    }
    if (gitSha) version = gitSha;
    const contentGate = evaluateGate(file.path, text, catalog.confidentiality);
    if (!contentGate.ok && contentGate.rule) {
      opts.metrics.refused += 1;
      opts.metrics.refusedByRule[contentGate.rule] = (opts.metrics.refusedByRule[contentGate.rule] ?? 0) + 1;
      logRefusal(file.path, contentGate.rule);
      await store.recordRefusal(catalog.id, file.path, contentGate.rule);
      continue;
    }
    const hash = contentHash(text);
    kept.push(file.rel);
    const existing = await store.getDocumentHash(catalog.id, file.rel);
    if (!opts.full && existing === hash) {
      opts.metrics.skippedUnchanged += 1;
      continue;
    }
    const chunks = chunkFile(file.path, text);
    const embeddings = await embedder.embed(chunks.map((c) => c.content));
    const docId = await store.upsertDocument({
      sourceId: catalog.id,
      path: file.rel,
      sourceUrl: citeUrl(catalog, file.rel),
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
          product: catalog.product,
          component: catalog.component,
          source_id: catalog.id,
          path: file.rel,
          source_url: citeUrl(catalog, file.rel),
          version,
          status: catalog.status,
          audience: catalog.audience,
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
  opts.metrics.deleted += await store.deleteMissingDocuments(catalog.id, kept);
}

export function emptyMetrics(): IngestMetrics {
  return {
    sources: 0,
    documents: 0,
    chunks: 0,
    skippedUnchanged: 0,
    skippedMissingLocal: 0,
    refused: 0,
    deleted: 0,
    refusedByRule: {},
  };
}
