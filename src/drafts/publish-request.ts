import type { Store } from "../db.js";
import { enqueueStandalonePost } from "../publish.js";
import type { StandalonePostKind } from "../post.js";
import { DRAFT_BODY_MAX } from "./types.js";
import { proactiveMaxPerDay } from "./generate.js";
import type { DraftRow } from "./types.js";

/** Short posts are ≤2000 chars (same ceiling as `DRAFT_BODY_MAX`); longer bodies are `long`. */
export function standaloneKindForDraftBody(body: string): StandalonePostKind {
  return body.length <= DRAFT_BODY_MAX ? "short" : "long";
}

/**
 * Operator approve: enqueue via `enqueueStandalonePost` (the only standalone
 * queue entry) then mark the draft approved with `publish_request_id`.
 *
 * Daily cap source of truth: `JEB_PROACTIVE_MAX_PER_DAY` at approve time
 * (`countApprovedProactiveToday` / `approveDraft` transaction). The publisher
 * does not re-check that cap; it enforces the proactive kill switch, outbound
 * scrubber, and rebuilds the post from `post_kind`/`attachments`.
 */
export async function approveDraftToPublishRequest(
  store: Store,
  opts: { draftId: number; decidedBy: string; env?: NodeJS.ProcessEnv },
): Promise<{ draft: DraftRow; publishRequestId: number; mentionKey: string; postId: string }> {
  const cap = proactiveMaxPerDay(opts.env);
  const existing = await store.getDraft(opts.draftId);
  if (!existing) throw new Error(`draft ${opts.draftId} not found`);
  if (existing.status !== "draft") throw new Error(`draft ${opts.draftId} is ${existing.status}, not draft`);
  const today = await store.countApprovedProactiveToday();
  if (today >= cap) {
    throw new Error(`proactive daily cap reached (${cap} approved per UTC day)`);
  }
  return store.approveDraft({
    id: opts.draftId,
    decidedBy: opts.decidedBy,
    maxPerDay: cap,
    enqueue: (client) =>
      enqueueStandalonePost(store, {
        content: existing.body,
        kind: standaloneKindForDraftBody(existing.body),
        approvedBy: opts.decidedBy,
        client,
      }),
  });
}
