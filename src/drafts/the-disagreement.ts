import { DraftRejectedError, finishDraft, isToolError, sanitizeDraftLabel, sanitizeUntrustedDraftText } from "./finish.js";
import { postLink } from "./scout-util.js";
import type { ScoutTools } from "./scout-util.js";
import type { Draft } from "./types.js";

interface DebateCluster {
  label?: string;
  author_ids?: string[];
  evidence_uris?: string[];
  claim_count?: number;
}

export async function generateTheDisagreement(opts: {
  scout: ScoutTools;
  appUrl: string;
  topic?: string;
}): Promise<Draft> {
  const topic = sanitizeUntrustedDraftText(opts.topic?.trim() || "pubky") || "pubky";
  const raw = await opts.scout.get_debate_map.execute({ topic });
  if (isToolError(raw)) throw new DraftRejectedError("the_disagreement", "scout unavailable");
  const clusters = Array.isArray((raw as { clusters?: unknown }).clusters)
    ? ((raw as { clusters: DebateCluster[] }).clusters ?? [])
    : [];
  const uris = clusters.flatMap((c) => c.evidence_uris ?? []).filter(Boolean);
  if (uris.length === 0) throw new DraftRejectedError("the_disagreement", "no evidence URI");
  const sides = clusters.slice(0, 4).map((c) => {
    const n = c.author_ids?.length ?? 0;
    const claims = c.claim_count ?? 0;
    const sample = (c.evidence_uris ?? []).slice(0, 2).map((u) => postLink(u, opts.appUrl)).filter(Boolean);
    const label = sanitizeDraftLabel(c.label ?? "") || "?";
    return `- Label "${label}" — ${n} author${n === 1 ? "" : "s"}, ${claims} tag claim${claims === 1 ? "" : "s"}. ${sample.join(" ")}`;
  });
  const body = [
    `The disagreement on "${topic}", from reply chains where participants tagged each other with differing labels. Sides are clusters, not a winner.`,
    "",
    ...sides,
    "",
    "My read: volume of tags is a signal of attention, not a verdict. Minority labels are listed when Scout returned them.",
  ].join("\n");
  return finishDraft({
    format: "the_disagreement",
    title: `The disagreement: ${topic}`,
    body,
    uris,
    tool_trace: [{ tool: "get_debate_map", topic, clusters: clusters.length }],
  });
}
