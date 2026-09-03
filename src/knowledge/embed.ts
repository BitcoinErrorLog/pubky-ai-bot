import { LOCAL_EMBED_DIM, LOCAL_EMBED_MODEL } from "./types.js";

export interface Embedder {
  modelId: string;
  dim: number;
  embed(texts: string[]): Promise<number[][]>;
}

type Extractor = (
  text: string,
  opts: { pooling: "mean"; normalize: boolean },
) => Promise<{ data: Float32Array | number[] }>;

let localPipeline: Extractor | null = null;
let loading: Promise<Extractor> | null = null;

async function loadLocalExtractor(): Promise<Extractor> {
  if (localPipeline) return localPipeline;
  if (!loading) {
    loading = (async () => {
      const cacheDir = process.env.JEB_MODEL_CACHE ?? new URL("../../.cache/jeb-models", import.meta.url).pathname;
      const mod = await import("@huggingface/transformers");
      const extractor = (await mod.pipeline("feature-extraction", LOCAL_EMBED_MODEL, {
        cache_dir: cacheDir,
      })) as unknown as Extractor;
      localPipeline = extractor;
      return extractor;
    })();
  }
  return loading;
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
