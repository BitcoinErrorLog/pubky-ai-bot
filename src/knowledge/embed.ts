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
  text: string,
  opts: { pooling: "mean"; normalize: boolean },
) => Promise<{ data: Float32Array | number[] }>;

export type EmbedDtype = "fp32" | "q8" | "q4" | "fp16";

let localPipeline: Extractor | null = null;
let loading: Promise<Extractor> | null = null;
let unavailableLogged = false;

export function modelCacheDir(): string {
  return process.env.JEB_MODEL_CACHE ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "../../.cache/jeb-models");
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

function ortIntraOpThreads(): number {
  const n = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(2, n));
}

function knowledgeUnavailable(reason: string): KnowledgeUnavailableError {
  if (!unavailableLogged) {
    unavailableLogged = true;
    log.warn({ err: reason }, `embeddings unavailable: ${reason}`);
  }
  return new KnowledgeUnavailableError(reason);
}

function configureTransformersEnv(mod: typeof import("@huggingface/transformers"), cacheDir: string, onlyLocal: boolean): void {
  mod.env.cacheDir = cacheDir;
  mod.env.allowLocalModels = true;
  mod.env.allowRemoteModels = !onlyLocal;
  const wasm = mod.env.backends.onnx.wasm as { numThreads?: number } | undefined;
  if (wasm) wasm.numThreads = 1;
}

async function loadLocalExtractor(): Promise<Extractor> {
  const cacheDir = modelCacheDir();
  const onlyLocal = localFilesOnly();
  if (onlyLocal && !cacheHasLocalModel(cacheDir)) {
    throw knowledgeUnavailable(`embedding model missing in ${cacheDir}; runtime must not download`);
  }
  if (localPipeline) return localPipeline;
  if (!loading) {
    loading = (async () => {
      try {
        const dtype = embedDtype();
        const mod = await import("@huggingface/transformers");
        configureTransformersEnv(mod, cacheDir, onlyLocal);
        const threads = ortIntraOpThreads();
        const extractor = (await mod.pipeline("feature-extraction", LOCAL_EMBED_MODEL, {
          cache_dir: cacheDir,
          local_files_only: onlyLocal,
          dtype,
          device: "cpu",
          session_options: {
            intraOpNumThreads: threads,
            interOpNumThreads: 1,
            executionMode: "sequential",
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
export async function warmLocalEmbeddings(): Promise<number> {
  const started = Date.now();
  const extractor = await loadLocalExtractor();
  await extractor("warmup", { pooling: "mean", normalize: true });
  return Date.now() - started;
}

export function localEmbedder(): Embedder {
  return {
    modelId: LOCAL_EMBED_MODEL,
    dim: LOCAL_EMBED_DIM,
    async embed(texts: string[]): Promise<number[][]> {
      const extractor = await loadLocalExtractor();
      const out: number[][] = [];
      for (const text of texts) {
        const clipped = text.slice(0, 8000) || " ";
        const result = await extractor(clipped, { pooling: "mean", normalize: true });
        const data = Array.from(result.data);
        if (data.length !== LOCAL_EMBED_DIM) {
          throw new Error(`local embed dim ${data.length} != ${LOCAL_EMBED_DIM}`);
        }
        out.push(data);
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

export function embedderFromEnv(): Embedder {
  const provider = (process.env.JEB_EMBED_PROVIDER ?? "local").trim();
  if (provider === "openai-compatible") return openaiCompatibleEmbedder();
  return localEmbedder();
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
