import { parseFeedProposalV1, type FeedProposalV1, type TenantV1 } from "../pubchi-schemas/index.js";
import type { Brain } from "../bot-kit/brain/types.js";
import type { ServiceErrorCode } from "./codes.js";
import { renderOwnerContext, type OwnerContext } from "./owner-context.js";

export type FeedTiming = { nexus_ms?: number; nlq_ms?: number; brain_ms?: number };
export type FeedOk = { ok: true; result: FeedProposalV1; timings?: FeedTiming };
export type FeedFail = { ok: false; code: ServiceErrorCode; stage?: "feed"; cause?: string; timings?: FeedTiming };
export type FeedOutcome = FeedOk | FeedFail;

const FEED_SYSTEM = [
  "Convert the request into one JSON object with this shape:",
  "{\"feed\":{\"tags\":string[],\"domain_tags\":string[],\"reach\":\"following\"|\"friends\"|\"all\"|\"wot\"|\"me\",\"layout\":\"columns\"|\"wide\"|\"visual\"|\"list\",\"sort\":\"recent\"|\"popularity\",\"content\":\"short\"|\"long\"|\"image\"|\"video\"|\"link\"|\"file\"|\"collection\"},\"name\":string}.",
  "Do not emit created_at; the server sets it. reach wot means two-hop web of trust.",
  "Likes are unsupported: return exactly {\"unsupported\":\"likes\"}. Followers reach is unsupported: return exactly {\"unsupported\":\"reach\"}.",
  "Return only JSON.",
].join(" ");

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced?.[1]?.trim() ?? trimmed;
  return JSON.parse(raw) as unknown;
}

function utteranceMentionsLikes(text: string): boolean {
  return /\blikes?\b/i.test(text);
}

function utteranceMentionsFollowersReach(text: string): boolean {
  return /\bfollowers?\s+reach\b|\breach\s+(?:of\s+)?followers?\b|\bonly\s+followers\b/i.test(text);
}

/** Conservative char/4 estimate used to reject over-budget questions before the brain. */
export function estimateInputTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export async function runFeed(opts: {
  tenant: TenantV1;
  body: unknown;
  now: number;
  brain: Brain;
  ownerContext?: OwnerContext;
}): Promise<FeedOutcome> {
  const rec = asRecord(opts.body);
  const question =
    (typeof rec?.question === "string" && rec.question.trim()) ||
    (typeof rec?.utterance === "string" && rec.utterance.trim()) ||
    "";
  if (!question) return { ok: false, code: "SCHEMA_INVALID", stage: "feed", cause: "empty_question" };
  if (estimateInputTokens(question) > opts.tenant.budgets.per_request_input_tokens) {
    return { ok: false, code: "SCHEMA_INVALID", stage: "feed", cause: "input_tokens" };
  }
  if (utteranceMentionsLikes(question)) return { ok: false, code: "FEED_UNSUPPORTED_LIKES", stage: "feed", cause: "likes" };
  if (utteranceMentionsFollowersReach(question)) {
    return { ok: false, code: "FEED_UNSUPPORTED_REACH", stage: "feed", cause: "followers_reach" };
  }

  let text: string;
  const brainStarted = performance.now();
  const ownerContext = renderOwnerContext(opts.ownerContext);
  try {
    const generated = await opts.brain.generate({
      messages: [
        { role: "system", content: FEED_SYSTEM },
        { role: "user", content: ownerContext ? `${question}\n\n${ownerContext}` : question },
      ],
      temperature: opts.brain.temperature,
      abortSignal: AbortSignal.timeout(opts.tenant.budgets.per_request_wall_clock_ms),
      maxOutputTokens: Math.min(300, opts.tenant.budgets.per_request_output_tokens),
    });
    text = generated.text;
  } catch {
    return { ok: false, code: "BRAIN_UNAVAILABLE", stage: "feed", cause: "brain_throw", timings: { brain_ms: Math.round(performance.now() - brainStarted) } };
  }

  let parsedJson: unknown;
  try {
    parsedJson = extractJson(text);
  } catch {
    return { ok: false, code: "FEED_SPECS_INVALID", stage: "feed", cause: "json_parse" };
  }
  const unsupported = asRecord(parsedJson)?.unsupported;
  if (unsupported === "likes") return { ok: false, code: "FEED_UNSUPPORTED_LIKES", stage: "feed", cause: "likes" };
  if (unsupported === "reach") return { ok: false, code: "FEED_UNSUPPORTED_REACH", stage: "feed", cause: "reach" };

  const rawFeed = asRecord(parsedJson);
  if (!rawFeed) return { ok: false, code: "FEED_SPECS_INVALID", stage: "feed", cause: "not_object" };
  const { created_at: _ignored, ...rest } = rawFeed;
  const feed = { ...rest, created_at: opts.now };
  const proposal = {
    schema: "pubchi-feed-proposal" as const,
    version: 1 as const,
    bot: opts.tenant.bot,
    owner: opts.tenant.owner,
    generated_at: opts.now,
    feed,
    warnings: [] as FeedProposalV1["warnings"],
    installed_user_feed_id: null,
  };
  const checked = parseFeedProposalV1(proposal);
  const brainMs = Math.round(performance.now() - brainStarted);
  if (!checked.ok) return { ok: false, code: checked.code, stage: "feed", cause: checked.code, timings: { brain_ms: brainMs } };
  return { ok: true, result: checked.value, timings: { brain_ms: brainMs } };
}
