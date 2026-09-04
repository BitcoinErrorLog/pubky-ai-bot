import type { Store, Queryable } from "../db.js";
import { enqueueStandalonePost } from "../publish.js";
import type { StandalonePostKind } from "../post.js";
import { DRAFT_BODY_MAX, type DraftRow } from "./types.js";
import { proactiveMaxPerDay } from "./generate.js";

/** Short posts are ≤2000 chars (same ceiling as `DRAFT_BODY_MAX`); longer bodies are `long`. */
export function standaloneKindForDraftBody(body: string): StandalonePostKind {
  return body.length <= DRAFT_BODY_MAX ? "short" : "long";
}

/**
 * Operator approve: enqueue via `enqueueStandalonePost` (the only standalone
 * queue entry) then mark the draft approved with `publish_request_id`.
 *
 * Daily cap source of truth: `JEB_PROACTIVE_MAX_PER_DAY` at approve time.
 * Because that value is configurable (>1 is allowed), the cap is serialized
 * with `pg_advisory_xact_lock(JEB_PROACTIVE_CAP_LOCK)` inside `approveDraft`,
 * not a unique index on `proactive_utc_day`. The publisher does not re-check
 * that cap; it enforces the proactive kill switch, outbound scrubber, and
 * rebuilds the post from `post_kind`/`attachments`.
 *
 * The enqueue callback receives the `FOR UPDATE` locked row so the approved
 * bytes and the enqueued bytes are the same version (no pre-transaction read).
 */
export async function approveDraftToPublishRequest(
  store: Store,
  opts: { draftId: number; decidedBy: string; env?: NodeJS.ProcessEnv },
): Promise<{ draft: DraftRow; publishRequestId: number; mentionKey: string; postId: string }> {
  const cap = proactiveMaxPerDay(opts.env);
  return store.approveDraft({
    id: opts.draftId,
    decidedBy: opts.decidedBy,
    maxPerDay: cap,
    enqueue: (client: Queryable, locked: DraftRow) =>
      enqueueStandalonePost(store, {
        content: locked.body,
        kind: standaloneKindForDraftBody(locked.body),
        approvedBy: opts.decidedBy,
        client,
      }),
  });
}
