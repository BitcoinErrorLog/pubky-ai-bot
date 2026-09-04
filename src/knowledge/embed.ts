import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertDimension,
  embedderFromEnv as kitEmbedderFromEnv,
  embedDtype,
  KnowledgeUnavailableError,
  localEmbedder as kitLocalEmbedder,
  localFilesOnly,
  openaiCompatibleEmbedder,
  skipEmbeddingWarmup,
  toSqlVector,
  warmLocalEmbeddings as kitWarmLocalEmbeddings,
  type Embedder,
  type EmbedDtype,
  type EmbedRuntime,
  type KnowledgeUnavailablePayload,
} from "../bot-kit/knowledge/embed.js";

export {
  assertDimension,
  embedDtype,
  KnowledgeUnavailableError,
  localFilesOnly,
  openaiCompatibleEmbedder,
  skipEmbeddingWarmup,
  toSqlVector,
  type Embedder,
  type EmbedDtype,
  type EmbedRuntime,
  type KnowledgeUnavailablePayload,
};

/** Default cache stays at the Jeb repo root, not packages/bot-kit. */
export function modelCacheDir(): string {
  return process.env.JEB_MODEL_CACHE ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "../../.cache/jeb-models");
}

function runtime(): EmbedRuntime {
  return { cacheDir: modelCacheDir() };
}

export function localEmbedder(): Embedder {
  return kitLocalEmbedder(runtime());
}

export function embedderFromEnv(): Embedder {
  return kitEmbedderFromEnv(runtime());
}

export async function warmLocalEmbeddings(): Promise<number> {
  return kitWarmLocalEmbeddings(runtime());
}
