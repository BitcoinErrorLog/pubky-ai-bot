import {
  cloneGitSource,
  contentHash,
  emptyMetrics,
  GIT_CLONE_MAX_BYTES,
  GIT_CLONE_TIMEOUT_MS,
  GIT_SOURCE_URL,
  gitChildEnv,
  HTTP_SOURCE_MAX_BYTES,
  HTTP_SOURCE_TIMEOUT_MS,
  ingestSource as kitIngestSource,
  listSourceFiles,
  readSourceFile,
} from "../bot-kit/knowledge/ingest.js";
import type { Embedder } from "./embed.js";
import { evaluateGate } from "./gate.js";
import { KnowledgeStore } from "./store.js";
import type { IngestMetrics, SourceEntry } from "./types.js";

export {
  cloneGitSource,
  contentHash,
  emptyMetrics,
  GIT_CLONE_MAX_BYTES,
  GIT_CLONE_TIMEOUT_MS,
  GIT_SOURCE_URL,
  gitChildEnv,
  HTTP_SOURCE_MAX_BYTES,
  HTTP_SOURCE_TIMEOUT_MS,
  listSourceFiles,
  readSourceFile,
};

export async function ingestSource(
  store: KnowledgeStore,
  entry: SourceEntry,
  embedder: Embedder,
  opts: { full: boolean; metrics: IngestMetrics },
): Promise<void> {
  return kitIngestSource(store, entry, embedder, { ...opts, gate: evaluateGate });
}
