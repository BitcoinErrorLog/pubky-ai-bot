import type { Store } from "./db.js";
import { log } from "./log.js";
import { isNotifiedSkip, type NotifiedSkip } from "./policy.js";
import { lintVoice } from "./voice.js";

export const POLICY_NOTICE_KIND = "policy_notice";
export const NOTICE_SUPPRESSION_HOURS = 6;

export const SKIP_NOTICE_TEXT: Record<NotifiedSkip, string> = {
  budget: "I've used my answer budget for today; it resets at 00:00 UTC. Mention me again after that.",
  user_hourly_cap: "I've answered you a few times this hour; I'll pick up again in a bit.",
  user_turn_cap: "That's my limit for one thread with one person. Start a new post if you want to keep going.",
  thread_cap: "This thread has hit my reply cap. Start a new post and I'll answer there.",
};

export function skipNoticeText(reason: NotifiedSkip): string {
  const raw = SKIP_NOTICE_TEXT[reason];
  const linted = lintVoice(raw);
  if (linted.violations.length) {
    throw new Error(`skip notice ${reason} failed voice lint: ${linted.violations.map((v) => v.rule).join(",")}`);
  }
  return linted.text;
}

/**
 * One deterministic notice for a resource-limit skip, or a silent skip when
 * anti-spam applies. A sent notice stays `processing` (so the publisher PUTs
 * it) with `skip_reason` set; a suppressed hit is `skipped` with
 * `notice_suppressed`. Deliberately takes no `replacePostId`: a notice must
 * never overwrite a previously published answer (2026-09-04 audit F-5).
 */
export async function queueSkipNotice(opts: {
  store: Store;
  mentionKey: string;
  author: string;
  parentUri: string;
  reason: NotifiedSkip;
  rootUri: string;
}): Promise<"sent" | "suppressed"> {
  if (!isNotifiedSkip(opts.reason)) {
    await opts.store.mark(opts.mentionKey, "skipped", { rootUri: opts.rootUri, skipReason: opts.reason });
    return "suppressed";
  }
  const authorRecent = await opts.store.hasPolicyNoticeForAuthor(opts.author, opts.reason, NOTICE_SUPPRESSION_HOURS);
  const threadSeen = await opts.store.hasPolicyNoticeInThread(opts.rootUri, opts.reason);
  if (authorRecent || threadSeen) {
    await opts.store.mark(opts.mentionKey, "skipped", {
      rootUri: opts.rootUri,
      skipReason: opts.reason,
      noticeSuppressed: true,
    });
    log.info(
      { mention_key: opts.mentionKey, skip_reason: opts.reason, notice_suppressed: true },
      "notice_suppressed",
    );
    return "suppressed";
  }
  const content = skipNoticeText(opts.reason);
  const evidenceId = await opts.store.insertEvidence({
    mentionKey: opts.mentionKey,
    intent: "decline",
    toolTrace: [{ kind: POLICY_NOTICE_KIND, fallback_reason: opts.reason }],
    sources: [],
    model: null,
    tokens: 0,
    latencyMs: 0,
    categories: ["declined"],
    kind: POLICY_NOTICE_KIND,
    fallbackReason: opts.reason,
  });
  await opts.store.insertPublishRequest({
    mentionKey: opts.mentionKey,
    parentUri: opts.parentUri,
    content,
    evidenceId,
    categories: ["declined"],
  });
  // Stay `processing` so the publisher will PUT the notice (it ignores skipped rows).
  await opts.store.mark(opts.mentionKey, "processing", {
    rootUri: opts.rootUri,
    skipReason: opts.reason,
    noticeSuppressed: false,
  });
  log.info({ mention_key: opts.mentionKey, skip_reason: opts.reason, kind: POLICY_NOTICE_KIND }, "policy skip notice queued");
  return "sent";
}
