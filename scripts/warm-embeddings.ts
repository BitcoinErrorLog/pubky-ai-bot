#!/usr/bin/env npx tsx
/**
 * Downloads Xenova/bge-small-en-v1.5 into JEB_MODEL_CACHE (Docker build).
 * Must not be used as a production boot path — the runtime image copies the cache.
 */
import { mkdirSync } from "node:fs";
import { localEmbedder, modelCacheDir, warmLocalEmbeddings } from "../src/knowledge/embed.js";

process.env.JEB_MODEL_LOCAL_ONLY = "0";
process.env.JEB_EMBED_DTYPE = process.env.JEB_EMBED_DTYPE ?? "q8";
const cache = modelCacheDir();
mkdirSync(cache, { recursive: true });
process.env.JEB_MODEL_CACHE = cache;
const ms = await warmLocalEmbeddings();
const [v] = await localEmbedder().embed(["cache probe"]);
if (v.length !== 384) throw new Error(`warm embed dim ${v.length}`);
console.log(`embeddings ready in ${ms} ms cache=${cache}`);
