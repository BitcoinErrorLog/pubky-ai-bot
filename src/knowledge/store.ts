import type pg from "pg";
import {
  KnowledgeStore as KitKnowledgeStore,
  isHistoricalQuery as kitIsHistoricalQuery,
  SUSPECT_SCORE_FACTOR,
  type ExplainHit,
} from "../bot-kit/knowledge/store.js";
import { HISTORICAL_CUES, JEB_RETRIEVAL_CONFIG } from "./retrieval-config.js";

export { SUSPECT_SCORE_FACTOR, type ExplainHit };
export { HISTORICAL_CUES };

export class KnowledgeStore extends KitKnowledgeStore {
  constructor(pool: pg.Pool) {
    super(pool, JEB_RETRIEVAL_CONFIG);
  }
}

export function isHistoricalQuery(query: string): boolean {
  return kitIsHistoricalQuery(query, HISTORICAL_CUES);
}
