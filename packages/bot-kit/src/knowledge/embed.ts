import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../log.js";
import { LOCAL_EMBED_DIM, LOCAL_EMBED_MODEL } from "./types.js";

export interface Embedder {
  modelId: string;
  dim: number;
  embed(texts: string[]): Promise<number[][]>;
}

export type KnowledgeUnavailablePayload = {
  error: "knowledge unavailable";
  reason: string;
};

export class KnowledgeUnavailableError extends Error {
  readonly code = "knowledge_unavailable" as const;
  constructor(reason: string) {
    super(reason);
    this.name = "KnowledgeUnavailableError";
  }

  toToolError(): KnowledgeUnavailablePayload {
    return { error: "knowledge unavailable", reason: this.message };
  }
}

type Extractor = (
  text: string | string[],
  opts: { pooling: "mean"; normalize: boolean },
) => Promise<{ data: Float32Array | number[] }>;

export type EmbedDtype = "fp32" | "q8" | "q4" | "fp16";
export const LOCAL_EMBED_BATCH_SIZE = 24;

let localPipeline: Extractor | null = null;
let loading: Promise<Extractor> | null = null;
let disposing: Promise<void> | null = null;
let unavailableLogged = false;

export type EmbedRuntime = {
  cacheDir?: string;
};

export function modelCacheDir(runtime?: EmbedRuntime): string {
  if (runtime?.cacheDir) return runtime.cacheDir;
  if (process.env.JEB_MODEL_CACHE) return process.env.JEB_MODEL_CACHE;
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../.cache/jeb-models");
}

export function embedDtype(): EmbedDtype {
  const raw = (process.env.JEB_EMBED_DTYPE ?? "q8").trim().toLowerCase();
  if (raw === "fp32" || raw === "q8" || raw === "q4" || raw === "fp16") return raw;
  throw new Error(`invalid JEB_EMBED_DTYPE ${raw}`);
}

function cacheHasLocalModel(cacheDir: string): boolean {
  const hf = path.join(cacheDir, "models--Xenova--bge-small-en-v1.5");
  const nested = path.join(cacheDir, "Xenova", "bge-small-en-v1.5");
  return existsSync(hf) || existsSync(nested);
}

export function localFilesOnly(): boolean {
  if (process.env.JEB_MODEL_LOCAL_ONLY === "0") return false;
  if (process.env.JEB_MODEL_LOCAL_ONLY === "1") return true;
  return process.env.NODE_ENV === "production";
}

/** Contract and canned-reply processes never load onnxruntime. */
export function skipEmbeddingWarmup(): boolean {
  if (process.env.JEB_CONTRACT_MODE === "1") return true;
  const canned = process.env.JEB_CANNED_REPLY;
  return canned !== undefined && canned.trim() !== "";
}

export function embedDevice(): string {
  const raw = (process.env.JEB_EMBED_DEVICE ?? "cpu").trim().toLowerCase();
  return raw || "cpu";
}

export function embedThreads(): number {
  const raw = process.env.JEB_EMBED_THREADS?.trim();
  if (raw) {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new Error(`invalid JEB_EMBED_THREADS ${raw}`);
    }
    return parsed;
  }
  const n = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(8, n));
}

function knowledgeUnavailable(reason: string): KnowledgeUnavailableError {
  if (!unavailableLogged) {
    unavailableLogged = true;
    log.warn({ err: reason }, `embeddings unavailable: ${reason}`);
  }
  return new KnowledgeUnavailableError(reason);
}

function configureTransformersEnv(
  mod: typeof import("@huggingface/transformers"),
  cacheDir: string,
  onlyLocal: boolean,
  threads: number,
): void {
  mod.env.cacheDir = cacheDir;
  mod.env.allowLocalModels = true;
  mod.env.allowRemoteModels = !onlyLocal;
  const wasm = mod.env.backends.onnx.wasm as { numThreads?: number } | undefined;
  if (wasm) wasm.numThreads = threads;
}

async function loadLocalExtractor(runtime?: EmbedRuntime): Promise<Extractor> {
  if (disposing) await disposing;
  const cacheDir = modelCacheDir(runtime);
  const onlyLocal = localFilesOnly();
  if (onlyLocal && !cacheHasLocalModel(cacheDir)) {
    throw knowledgeUnavailable(`embedding model missing in ${cacheDir}; runtime must not download`);
  }
  if (localPipeline) return localPipeline;
  if (!loading) {
    loading = (async () => {
      try {
        const dtype = embedDtype();
        const device = embedDevice();
        const threads = embedThreads();
        const mod = await import("@huggingface/transformers");
        configureTransformersEnv(mod, cacheDir, onlyLocal, threads);
        const extractor = (await mod.pipeline("feature-extraction", LOCAL_EMBED_MODEL, {
          cache_dir: cacheDir,
          local_files_only: onlyLocal,
          dtype,
          device: device as never,
          session_options: {
            intraOpNumThreads: threads,
            interOpNumThreads: threads > 1 ? Math.min(2, threads) : 1,
            executionMode: threads > 1 ? "parallel" : "sequential",
          },
        })) as unknown as Extractor;
        localPipeline = extractor;
        return extractor;
      } catch (e) {
        loading = null;
        const reason = e instanceof Error ? e.message : String(e);
        throw e instanceof KnowledgeUnavailableError ? e : knowledgeUnavailable(reason);
      }
    })();
  }
  return loading;
}

/** Load the local extractor and run one dummy embed. Returns wall ms. */
export async function warmLocalEmbeddings(runtime?: EmbedRuntime): Promise<number> {
  const started = Date.now();
  const extractor = await loadLocalExtractor(runtime);
  await extractor("warmup", { pooling: "mean", normalize: true });
  return Date.now() - started;
}

/** Release the native ONNX session and worker resources used by local embeddings. */
export async function disposeLocalEmbeddings(): Promise<void> {
  if (disposing) return disposing;
  disposing = (async () => {
    const pending = loading;
    let extractor = localPipeline as (Extractor & { dispose?: () => Promise<unknown> }) | null;
    try {
      if (pending) extractor = (await pending) as Extractor & { dispose?: () => Promise<unknown> };
    } catch {
      // A failed load has no native session to tear down.
    }
    localPipeline = null;
    loading = null;
    if (extractor?.dispose) await extractor.dispose();
  })().finally(() => {
    disposing = null;
  });
  return disposing;
}

export function localEmbedder(runtime?: EmbedRuntime): Embedder {
  return {
    modelId: LOCAL_EMBED_MODEL,
    dim: LOCAL_EMBED_DIM,
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      const extractor = await loadLocalExtractor(runtime);
      const out: number[][] = [];
      for (let offset = 0; offset < texts.length; offset += LOCAL_EMBED_BATCH_SIZE) {
        const batch = texts
          .slice(offset, offset + LOCAL_EMBED_BATCH_SIZE)
          .map((text) => text.slice(0, 8000) || " ");
        const result = await extractor(batch.length === 1 ? batch[0] : batch, {
          pooling: "mean",
          normalize: true,
        });
        const expected = batch.length * LOCAL_EMBED_DIM;
        if (result.data.length !== expected) {
          throw new Error(`local embed dim ${result.data.length} != ${expected}`);
        }
        for (let i = 0; i < batch.length; i += 1) {
          const start = i * LOCAL_EMBED_DIM;
          out.push(Array.from(result.data.slice(start, start + LOCAL_EMBED_DIM)));
        }
      }
      return out;
    },
  };
}

export function openaiCompatibleEmbedder(): Embedder {
  const model = process.env.JEB_EMBED_MODEL?.trim();
  const apiKey = process.env.JEB_EMBED_API_KEY?.trim();
  const baseUrl = (process.env.JEB_EMBED_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/$/, "");
  if (!model) throw new Error("JEB_EMBED_MODEL required for openai-compatible embeddings");
  if (!apiKey) throw new Error("JEB_EMBED_API_KEY required for openai-compatible embeddings");
  return {
    modelId: model,
    dim: LOCAL_EMBED_DIM,
    async embed(texts: string[]): Promise<number[][]> {
      const res = await fetch(`${baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model, input: texts.map((t) => t.slice(0, 8000) || " ") }),
      });
      if (!res.ok) throw new Error(`embed http ${res.status}`);
      const body = (await res.json()) as { data: Array<{ embedding: number[] }> };
      return body.data.map((d) => {
        if (d.embedding.length !== LOCAL_EMBED_DIM) {
          throw new Error(`dimension mismatch: model returned ${d.embedding.length}, expected ${LOCAL_EMBED_DIM}`);
        }
        return d.embedding;
      });
    },
  };
}

export function embedderFromEnv(runtime?: EmbedRuntime): Embedder {
  const provider = (process.env.JEB_EMBED_PROVIDER ?? "local").trim();
  if (provider === "openai-compatible") return openaiCompatibleEmbedder();
  return localEmbedder(runtime);
}

export function assertDimension(expected: number | null, actual: number, modelId: string): void {
  if (expected !== null && expected !== actual) {
    throw new Error(`dimension mismatch: source uses ${expected}, embedder ${modelId} uses ${actual}`);
  }
  if (actual !== LOCAL_EMBED_DIM) {
    throw new Error(`dimension mismatch: only ${LOCAL_EMBED_DIM}-d embeddings are stored`);
  }
}

export function toSqlVector(values: number[]): string {
  return `[${values.join(",")}]`;
}
