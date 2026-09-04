import { embeddingQuery as kitEmbeddingQuery, extraTsquery as kitExtraTsquery } from "../bot-kit/knowledge/query.js";
import { JEB_QUERY_EXPANSION } from "./retrieval-config.js";

export { JEB_ALIAS_GROUPS, JEB_PRODUCT_CUES, JEB_QUERY_EXPANSION } from "./retrieval-config.js";

export function extraTsquery(question: string): string {
  return kitExtraTsquery(question, JEB_QUERY_EXPANSION);
}

export function embeddingQuery(question: string): string {
  return kitEmbeddingQuery(question, JEB_QUERY_EXPANSION);
}
