import { buildStandalonePost } from "../post.js";
import { assertOutboundClean } from "../outbound-gate.js";
import type { Store } from "../db.js";
import { proactiveMaxPerDay } from "./generate.js";
import type { DraftRow, StandalonePublishInsert } from "./types.js";

export function standalonePublishFromDraft(
  botPk: string,
  row: Pick<DraftRow, "id" | "title" | "body">,
): StandalonePublishInsert {
  const kind = row.title ? "long" : "short";
  const content = kind === "long" ? JSON.stringify({ title: row.title, body: row.body }) : row.body;
  assertOutboundClean(content);
  const built = buildStandalonePost(botPk, content, kind, null);
  return {
    mentionKey: built.url,
    parentUri: built.url,
    content,
    categories: ["standalone", "proactive"],
    standalone: true,
    postJson: built.json,
    postPath: built.path,
  };
}

export async function approveDraftToPublishRequest(
  store: Store,
  opts: { draftId: number; decidedBy: string; botPk: string; env?: NodeJS.ProcessEnv },
): Promise<{ draft: DraftRow; publishRequestId: number }> {
  const cap = proactiveMaxPerDay(opts.env);
  const existing = await store.getDraft(opts.draftId);
  if (!existing) throw new Error(`draft ${opts.draftId} not found`);
  if (existing.status !== "draft") throw new Error(`draft ${opts.draftId} is ${existing.status}, not draft`);
  const today = await store.countApprovedProactiveToday();
  if (today >= cap) {
    throw new Error(`proactive daily cap reached (${cap} approved per UTC day)`);
  }
  const req = standalonePublishFromDraft(opts.botPk, existing);
  return store.approveDraft({
    id: opts.draftId,
    decidedBy: opts.decidedBy,
    request: req,
    maxPerDay: cap,
  });
}
