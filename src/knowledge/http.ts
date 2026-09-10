import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import { InjectionDetector } from "../injection-detector.js";
import { log } from "../log.js";
import { embedderFromEnv } from "./embed.js";
import { retrieveKnowledge } from "./retrieve.js";
import { KnowledgeStore } from "./store.js";
import type { Embedder } from "./embed.js";
import type { RetrievalResult } from "./types.js";

export const KNOWLEDGE_PATH = "/internal/knowledge/retrieve";
export const KNOWLEDGE_DEADLINE_MS = 2_500;
export const KNOWLEDGE_MAX_CHARS = 6_000;

const requestSchema = z
  .object({
    query: z.string().trim().min(1).max(300),
    k: z.number().int().min(1).max(6).optional(),
  })
  .strict();

export const PUBLIC_STATUSES = ["canonical", "released"] as const;
const PUBLIC_STATUS_SET = new Set<string>(PUBLIC_STATUSES);

// Wire compatibility: "public" describes the confidentiality corpus, not s.audience.
export const remoteKnowledgePayloadSchema = z
  .object({
    audience: z.literal("public"),
    chunks: z
      .array(
        z
          .object({
            title: z.string().min(1),
            url: z.string().url().refine((value) => value.startsWith("https://")),
            source_id: z.string().min(1),
            corpus_version: z.string().min(1),
            snippet: z.string().min(1).max(240),
          })
          .strict(),
      )
      .max(6),
    truncated: z.boolean(),
  })
  .strict();

export type RemoteKnowledgePayload = z.infer<typeof remoteKnowledgePayloadSchema>;

export type KnowledgeRetrievalOptions = {
  pool: pg.Pool;
  token: string;
  privateHost: string;
  bind?: string;
  port?: number;
  retrieve?: (query: string, k: number) => Promise<RetrievalResult>;
  embedder?: Embedder;
  now?: () => number;
};

type Bucket = { tokens: number; at: number };

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function tokenMatches(got: string | undefined, expected: string): boolean {
  if (!got) return false;
  const actual = Buffer.from(got);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function privateHostMatches(req: IncomingMessage, expected: string): boolean {
  const host = (req.headers.host ?? "").split(":")[0].toLowerCase();
  return host === expected.toLowerCase();
}

function readBody(req: IncomingMessage, maxBytes = 8_192): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function titleFor(chunk: RetrievalResult["chunks"][number]): string {
  if (chunk.source_url) {
    const path = new URL(chunk.source_url).pathname.split("/").filter(Boolean);
    const leaf = path.at(-1)?.replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ").trim();
    if (leaf) return leaf;
  }
  return chunk.product || chunk.component || chunk.source_id;
}

function snippetFor(content: string): string {
  const detector = new InjectionDetector();
  return Array.from(detector.detect(content, undefined, { sanitize: true }).sanitized)
    .slice(0, 240)
    .join("")
    .trim();
}

export function publicKnowledgePayload(result: RetrievalResult): RemoteKnowledgePayload {
  const seen = new Set<string>();
  const chunks: RemoteKnowledgePayload["chunks"] = [];
  let chars = 0;
  for (const chunk of result.chunks) {
    if (
      !PUBLIC_STATUS_SET.has(chunk.status) ||
      chunk.confidentiality !== "public" ||
      !chunk.source_url?.startsWith("https://")
    )
      continue;
    if (seen.has(chunk.source_id)) continue;
    const snippet = snippetFor(chunk.content);
    if (!snippet || chars + Array.from(snippet).length > KNOWLEDGE_MAX_CHARS) continue;
    seen.add(chunk.source_id);
    chars += Array.from(snippet).length;
    chunks.push({
      title: titleFor(chunk),
      url: chunk.source_url,
      source_id: chunk.source_id,
      corpus_version: chunk.version ?? "unknown",
      snippet,
    });
    if (chunks.length === 6) break;
  }
  return { audience: "public", chunks, truncated: result.truncated || chunks.length < result.chunks.length };
}

export function assertKnowledgeEndpointConfig(enabled: boolean, token: string | undefined): void {
  if (!enabled) return;
  if (!token || Buffer.byteLength(token, "utf8") < 32) {
    throw new Error("PUBCHI_KNOWLEDGE_TOKEN must be at least 32 bytes when knowledge endpoint is enabled");
  }
}

export function createKnowledgeHandler(opts: KnowledgeRetrievalOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const now = opts.now ?? Date.now;
  const buckets = new Map<string, Bucket>();
  const retrieve =
    opts.retrieve ??
    (async (query: string, k: number) =>
      retrieveKnowledge(new KnowledgeStore(opts.pool), opts.embedder ?? embedderFromEnv(), query, {
        confidentiality: "public",
        statuses: PUBLIC_STATUSES,
        k,
      }));

  return async (req, res) => {
    if (req.method !== "POST" || (req.url ?? "").split("?")[0] !== KNOWLEDGE_PATH) {
      writeJson(res, 404, { error: "UPSTREAM_UNAVAILABLE" });
      return;
    }
    if (!privateHostMatches(req, opts.privateHost)) {
      writeJson(res, 401, { error: "UNAUTHORIZED" });
      return;
    }
    const auth = req.headers.authorization;
    if (!auth || !/^Bearer\s+/i.test(auth) || !tokenMatches(auth.replace(/^Bearer\s+/i, ""), opts.token)) {
      writeJson(res, 401, { error: "UNAUTHORIZED" });
      return;
    }
    const caller = req.socket.remoteAddress ?? "unknown";
    const t = now();
    const bucket = buckets.get(caller) ?? { tokens: 10, at: t };
    bucket.tokens = Math.min(10, bucket.tokens + Math.max(0, t - bucket.at) / 100);
    bucket.at = t;
    if (bucket.tokens < 1) {
      buckets.set(caller, bucket);
      writeJson(res, 429, { error: "RATE_LIMITED" });
      return;
    }
    bucket.tokens -= 1;
    buckets.set(caller, bucket);

    let input: unknown;
    try {
      input = JSON.parse(await readBody(req));
    } catch {
      writeJson(res, 400, { error: "SCHEMA_INVALID" });
      return;
    }
    const parsed = requestSchema.safeParse(input);
    if (!parsed.success) {
      writeJson(res, 400, { error: "SCHEMA_INVALID" });
      return;
    }
    const query = new InjectionDetector().detect(parsed.data.query, undefined, { sanitize: true }).sanitized;
    if (!query) {
      writeJson(res, 400, { error: "SCHEMA_INVALID" });
      return;
    }
    try {
      const result = await Promise.race([
        retrieve(query, parsed.data.k ?? 6),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("deadline")), KNOWLEDGE_DEADLINE_MS)),
      ]);
      const payload = publicKnowledgePayload(result);
      log.info(
        {
          event: "knowledge_retrieval",
          query_hash: createHash("sha256").update(query).digest("hex"),
          k: parsed.data.k ?? 6,
          returned: payload.chunks.length,
          dropped_by_visibility: result.chunks.filter(
            (chunk) => !PUBLIC_STATUS_SET.has(chunk.status) || chunk.confidentiality !== "public",
          ).length,
        },
        "knowledge retrieval",
      );
      writeJson(res, 200, payload);
    } catch {
      writeJson(res, 503, { error: "UPSTREAM_UNAVAILABLE" });
    }
  };
}

export function listenKnowledge(opts: KnowledgeRetrievalOptions): Server {
  assertKnowledgeEndpointConfig(true, opts.token);
  const server = createServer((req, res) => {
    void createKnowledgeHandler(opts)(req, res);
  });
  server.listen(opts.port, opts.bind ?? "::");
  return server;
}
