import { z } from "zod";

export const timeRangeSchema = z
  .object({
    since: z.number().int().nonnegative().optional(),
    until: z.number().int().nonnegative().optional(),
  })
  .optional();

export type TimeRange = { since: number; until: number };

export const graphScopeSchema = z
  .object({
    pubky: z.string().optional(),
    hops: z.number().int().min(1).max(3).optional(),
  })
  .optional();

export const claimSchema = z.object({
  label: z.string(),
  count: z.number().int().nonnegative(),
  claimant_ids: z.array(z.string()),
  self_claim: z.boolean().optional(),
  target_id: z.string().optional(),
});

export type Claim = z.infer<typeof claimSchema>;

export const scoutEnvelopeSchema = z.object({
  results: z.array(z.unknown()),
  count: z.number().int().nonnegative(),
  truncated: z.boolean(),
  notes: z.array(z.string()).optional(),
});

export const scoutErrorSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
  hint: z.string().optional(),
});

export type ScoutEnvelope = z.infer<typeof scoutEnvelopeSchema>;

export interface EvidenceMeta {
  provenance: "scout";
  tool: string;
  truncated: boolean;
  notes: string[];
  scope: {
    time_range: TimeRange;
    graph_scope?: { pubky?: string; hops?: number };
    filters?: Record<string, unknown>;
  };
}

export function defaultTimeRange(tr?: { since?: number; until?: number }): TimeRange {
  const until = tr?.until ?? Date.now();
  const since = tr?.since ?? until - 90 * 24 * 60 * 60 * 1000;
  return { since, until };
}

export function postUri(authorId: string, postId: string): string {
  return `pubky://${authorId}/pub/pubky.app/posts/${postId}`;
}

export const CLAIMANT_CAP_DEFAULT = 12;

export function capIds(ids: string[], cap: number): string[] {
  const uniq: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    uniq.push(id);
    if (uniq.length >= cap) break;
  }
  return uniq;
}
