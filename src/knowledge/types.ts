export const SOURCE_STATUSES = [
  "canonical",
  "released",
  "proposal",
  "opinion",
  "deprecated",
  "historical",
] as const;

export type SourceStatus = (typeof SOURCE_STATUSES)[number];

export const SOURCE_KINDS = ["git", "http", "local"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const CONFIDENTIALITY = ["public", "excluded"] as const;
export type Confidentiality = (typeof CONFIDENTIALITY)[number];

export interface SourceEntry {
  id: string;
  product: string;
  component: string;
  kind: SourceKind;
  location: string;
  include: string[];
  exclude: string[];
  status: SourceStatus;
  audience: string;
  confidentiality: Confidentiality;
  owner: string;
  cite_base?: string;
  ref?: string;
}

export interface Manifest {
  sources: SourceEntry[];
}

export interface Chunk {
  content: string;
  ordinal: number;
  kind: "markdown" | "code" | "mapping" | "prose";
}

export interface ChunkRecord {
  id: number;
  content: string;
  source_url: string | null;
  product: string;
  component: string;
  status: SourceStatus;
  version: string | null;
  score: number;
}

export interface RetrievalResult {
  chunks: ChunkRecord[];
  truncated: boolean;
}

export interface IngestMetrics {
  sources: number;
  documents: number;
  chunks: number;
  skippedUnchanged: number;
  skippedMissingLocal: number;
  refused: number;
  deleted: number;
  refusedByRule: Record<string, number>;
}

export const LOCAL_EMBED_MODEL = "Xenova/bge-small-en-v1.5";
export const LOCAL_EMBED_DIM = 384;
export const MAX_CHUNK_CHARS = 4800;
export const PROSE_OVERLAP_CHARS = 240;
