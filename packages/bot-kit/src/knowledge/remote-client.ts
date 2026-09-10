import { createHash } from "node:crypto";
import { z } from "zod";
import { postJson } from "../http.js";
import { log } from "../log.js";
import { ScoutCircuitBreaker } from "../scout/circuit.js";

const chunkSchema = z.object({
  title: z.string().min(1),
  url: z.string().url().refine((value) => value.startsWith("https://")),
  source_id: z.string().min(1),
  corpus_version: z.string().min(1),
  snippet: z.string().min(1).max(240),
});

const payloadSchema = z.object({
  audience: z.literal("public"),
  chunks: z.array(chunkSchema).max(6),
  truncated: z.boolean(),
});

export type RemoteKnowledgePayload = z.infer<typeof payloadSchema>;
export type RemoteKnowledgeClient = {
  search(query: string, k?: number): Promise<RemoteKnowledgePayload>;
};

export class RemoteKnowledgeError extends Error {
  constructor(
    readonly code: "RATE_LIMITED" | "UPSTREAM_UNAVAILABLE" | "SCHEMA_INVALID",
    message = "knowledge lookup unavailable",
  ) {
    super(message);
    this.name = "RemoteKnowledgeError";
  }
}

export function assertRemoteKnowledgeUrl(url: URL, allowedHost: string): void {
  if (url.hostname !== allowedHost || (url.protocol !== "http:" && url.protocol !== "https:")) {
    throw new Error("ssrf: knowledge host not allowed");
  }
}

export function createRemoteKnowledgeClient(opts: {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  breaker?: ScoutCircuitBreaker;
}): RemoteKnowledgeClient {
  const base = new URL(opts.baseUrl);
  const allowedHost = base.hostname;
  const timeoutMs = opts.timeoutMs ?? 2_500;
  const breaker = opts.breaker ?? new ScoutCircuitBreaker();
  if (Buffer.byteLength(opts.token, "utf8") < 32) throw new Error("knowledge token must be at least 32 bytes");

  return {
    async search(query: string, k = 6): Promise<RemoteKnowledgePayload> {
      if (breaker.blocked()) throw new RemoteKnowledgeError("UPSTREAM_UNAVAILABLE");
      const trimmed = query.trim();
      if (!trimmed || Array.from(trimmed).length > 300 || !Number.isInteger(k) || k < 1 || k > 6) {
        throw new RemoteKnowledgeError("SCHEMA_INVALID", "invalid knowledge query");
      }
      const url = new URL("/internal/knowledge/retrieve", base);
      assertRemoteKnowledgeUrl(url, allowedHost);
      const queryHash = createHash("sha256").update(trimmed).digest("hex");
      try {
        const response = await postJson(url, timeoutMs, { query: trimmed, k }, { authorization: `Bearer ${opts.token}` });
        if (response.status === 429) throw new RemoteKnowledgeError("RATE_LIMITED");
        if (response.status !== 200) throw new RemoteKnowledgeError("UPSTREAM_UNAVAILABLE");
        const parsed = payloadSchema.safeParse(response.body);
        if (!parsed.success) throw new RemoteKnowledgeError("SCHEMA_INVALID");
        breaker.noteOutcome(true);
        log.info({ event: "remote_knowledge_search", query_hash: queryHash, sources: parsed.data.chunks.length }, "remote knowledge search");
        return parsed.data;
      } catch (error) {
        breaker.noteOutcome(false);
        if (error instanceof RemoteKnowledgeError) throw error;
        log.warn({ event: "remote_knowledge_failed", query_hash: queryHash }, "remote knowledge unavailable");
        throw new RemoteKnowledgeError("UPSTREAM_UNAVAILABLE");
      }
    },
  };
}
