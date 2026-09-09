import { createHash } from "node:crypto";
import { parseFeedProposalV1, type FeedProposalV1, type TenantV1 } from "../pubchi-schemas/index.js";
import type { Brain } from "../bot-kit/brain/types.js";
import type { ServiceErrorCode } from "./codes.js";
import { renderOwnerContext, type OwnerContext } from "./owner-context.js";

export type FeedTiming = { nexus_ms?: number; nlq_ms?: number; brain_ms?: number };
export type FeedOk = { ok: true; result: FeedProposalV1; timings?: FeedTiming; settlementTokens?: number };
export type FeedFail = { ok: false; code: ServiceErrorCode; stage?: "feed"; cause?: string; timings?: FeedTiming; settlementTokens?: number };
export type FeedOutcome = FeedOk | FeedFail;
export type FeedTelemetry = {
  increment(name: "feed_retry" | "feed_cause", labels?: Record<string, string>): void;
};

const FEED_SYSTEM = [
  "A Pubky feed is a feed of POSTS, never a list of people or profiles.",
  "Convert the request into one JSON object with this shape:",
  "{\"feed\":{\"tags\":string[],\"domain_tags\":string[],\"reach\":\"following\"|\"friends\"|\"all\"|\"wot\"|\"me\",\"layout\":\"columns\"|\"wide\"|\"visual\"|\"list\",\"sort\":\"recent\"|\"popularity\",\"content\":\"short\"|\"long\"|\"image\"|\"video\"|\"link\"|\"file\"|\"collection\"},\"name\":string}.",
  "tags and domain_tags are the allowed tag filters; reach, sort, layout, and content must use only the listed enum values.",
  "Do not emit created_at; the server sets it. reach wot means two-hop web of trust.",
  "If asked for people tagged X, express the supported equivalent as posts tagged X and explain that in name.",
  "Example: 'bitcoin posts from my follows' -> {\"feed\":{\"tags\":[\"bitcoin\"],\"domain_tags\":[],\"reach\":\"following\",\"layout\":\"columns\",\"sort\":\"recent\",\"content\":\"short\"},\"name\":\"Bitcoin posts from my follows\"}.",
  "Example: 'people tagged bitcoin and synonym' -> {\"feed\":{\"tags\":[\"bitcoin\",\"synonym\"],\"domain_tags\":[],\"reach\":\"all\",\"layout\":\"columns\",\"sort\":\"recent\",\"content\":\"short\"},\"name\":\"Posts tagged bitcoin or synonym\"}.",
  "Likes are unsupported: return exactly {\"unsupported\":\"likes\"}. Followers reach is unsupported: return exactly {\"unsupported\":\"reach\"}.",
  "Return only JSON.",
].join(" ");
const FEED_MAX_OUTPUT_TOKENS = 1200;
const BRAIN_PROVIDER_OPTIONS = { moonshot: { thinking: { type: "disabled" } } };

function reportedUsageTokens(usage: {
  totalTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
} | undefined): number | undefined {
  if (!usage) return undefined;
  const fields = [usage.promptTokens, usage.completionTokens, usage.reasoningTokens].filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  );
  if (fields.length > 0) return fields.reduce((sum, value) => sum + value, 0);
  return typeof usage.totalTokens === "number" && Number.isFinite(usage.totalTokens) ? usage.totalTokens : undefined;
}

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
  telemetry?: FeedTelemetry;
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

  const brainStarted = performance.now();
  const deadline = brainStarted + opts.tenant.budgets.per_request_wall_clock_ms;
  const requestLabels = {
    request_hash: createHash("sha256").update(question).digest("hex").slice(0, 16),
    request_len: String(question.length),
  };
  const ownerContext = renderOwnerContext(opts.ownerContext, "feed");
  const userContent = ownerContext ? `${question}\n\n${ownerContext}` : question;
  let consumedTokens = 0;
  const generate = async (content: string): Promise<{ ok: true; text: string } | { ok: false }> => {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) return { ok: false };
    try {
      const generated = opts.brain.generate({
        messages: [
          { role: "system", content: FEED_SYSTEM },
          { role: "user", content },
        ],
        temperature: opts.brain.temperature,
        abortSignal: AbortSignal.timeout(remaining),
        maxOutputTokens: Math.min(FEED_MAX_OUTPUT_TOKENS, opts.tenant.budgets.per_request_output_tokens),
        providerOptions: BRAIN_PROVIDER_OPTIONS,
      });
      const timed = await Promise.race([
        generated,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("feed_wall_clock")), remaining)),
      ]);
      consumedTokens += reportedUsageTokens(timed.usage) ?? estimateInputTokens(question);
      return { ok: true, text: timed.text };
    } catch {
      consumedTokens += estimateInputTokens(question);
      return { ok: false };
    }
  };
  const parse = (text: string): { ok: true; result: FeedProposalV1 } | { ok: false; cause: "json_parse" | "schema" | "unsupported_intent"; code?: ServiceErrorCode } => {
    let parsedJson: unknown;
    try {
      parsedJson = extractJson(text);
    } catch {
      return { ok: false, cause: "json_parse" };
    }
    const unsupported = asRecord(parsedJson)?.unsupported;
    if (unsupported === "likes") return { ok: false, cause: "unsupported_intent", code: "FEED_UNSUPPORTED_LIKES" };
    if (unsupported === "reach") return { ok: false, cause: "unsupported_intent", code: "FEED_UNSUPPORTED_REACH" };
    const rawFeed = asRecord(parsedJson);
    if (!rawFeed) return { ok: false, cause: "schema" };
    const { created_at: _ignored, ...rest } = rawFeed;
    const proposal = {
      schema: "pubchi-feed-proposal" as const,
      version: 1 as const,
      bot: opts.tenant.bot,
      owner: opts.tenant.owner,
      generated_at: opts.now,
      feed: { ...rest, created_at: opts.now },
      warnings: [] as FeedProposalV1["warnings"],
      installed_user_feed_id: null,
    };
    const checked = parseFeedProposalV1(proposal);
    if (!checked.ok) {
      if (checked.code === "FEED_UNSUPPORTED_LIKES" || checked.code === "FEED_UNSUPPORTED_REACH") {
        return { ok: false, cause: "unsupported_intent", code: checked.code };
      }
      return { ok: false, cause: "schema", code: checked.code };
    }
    return { ok: true, result: checked.value };
  };
  const first = await generate(userContent);
  if (!first.ok) {
      return { ok: false, code: "BRAIN_UNAVAILABLE", stage: "feed", cause: "brain_throw", timings: { brain_ms: Math.round(performance.now() - brainStarted) }, settlementTokens: consumedTokens };
  }
  let checked = parse(first.text);
  if (!checked.ok && checked.cause !== "unsupported_intent") {
    opts.telemetry?.increment("feed_retry", requestLabels);
    const retry = await generate(`${userContent}\n\nValidation error: ${checked.cause}. Retry once with one valid JSON feed proposal.`);
    if (!retry.ok) {
      opts.telemetry?.increment("feed_cause", { ...requestLabels, cause: "schema" });
      return { ok: false, code: "FEED_SPECS_INVALID", stage: "feed", cause: "schema", timings: { brain_ms: Math.round(performance.now() - brainStarted) }, settlementTokens: consumedTokens };
    }
    checked = parse(retry.text);
  }
  const brainMs = Math.round(performance.now() - brainStarted);
  if (!checked.ok) {
    const code = checked.code ?? "FEED_SPECS_INVALID";
    if (code === "FEED_UNSUPPORTED_LIKES" || code === "FEED_UNSUPPORTED_REACH") {
      opts.telemetry?.increment("feed_cause", { ...requestLabels, cause: checked.cause });
      return { ok: false, code, stage: "feed", cause: checked.cause, timings: { brain_ms: brainMs }, settlementTokens: consumedTokens };
    }
    opts.telemetry?.increment("feed_cause", { ...requestLabels, cause: checked.cause });
    return { ok: false, code: "FEED_SPECS_INVALID", stage: "feed", cause: checked.cause, timings: { brain_ms: brainMs }, settlementTokens: consumedTokens };
  }
  return { ok: true, result: checked.result, timings: { brain_ms: brainMs }, settlementTokens: Math.max(1, consumedTokens) };
}
