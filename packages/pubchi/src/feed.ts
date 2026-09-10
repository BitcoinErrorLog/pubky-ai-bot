import { createHash } from "node:crypto";
import {
  FeedDraftV2Schema,
  parseFeedProposalV1,
  parseFeedProposalV2,
  type FeedProposalV1,
  type FeedProposalV2,
  type TenantV1,
} from "../pubchi-schemas/index.js";
import type { Brain } from "../bot-kit/brain/types.js";
import type { ServiceErrorCode } from "./codes.js";
import { renderOwnerContext, type OwnerContext } from "./owner-context.js";
import { estimateBrainTokens } from "./brain-usage.js";
import { pubchiFeedProposalV2Enabled } from "./env.js";

export type FeedTiming = { nexus_ms?: number; nlq_ms?: number; brain_ms?: number };
export type FeedOk = { ok: true; result: FeedProposalV1 | FeedProposalV2; timings?: FeedTiming; settlementTokens?: number };
export type FeedFail = { ok: false; code: ServiceErrorCode; stage?: "feed"; cause?: string; timings?: FeedTiming; settlementTokens?: number };
export type FeedOutcome = FeedOk | FeedFail;
export type FeedTelemetry = {
  increment(name: "feed_retry" | "feed_cause", labels?: Record<string, string>): void;
};

const FEED_SYSTEM = [
  "A Pubky feed is a feed of POSTS, never a list of people or profiles.",
  "The specification is pubky-app-specs 0.7.0 and pubchi-feed-proposal version 2.",
  "Output only JSON with name, icon, feed, mapping, and warnings.",
  "Required feed fields are tags (optional, up to 5 strings of 20 characters), domain_tags (optional, up to 5 strings of 20 characters), reach, sort, and layout.",
  "Reach: following means people you follow; followers means people who follow you and is NOT authorable by this App; friends means mutual follows; all means everyone; wot means within two hops of your follows; me means only you.",
  "Sort: recent means newest posts; popularity means bookmarks, reposts, and replies.",
  "Layout: columns means multi-column cards; wide means wide cards; visual means image-forward; list means compact list.",
  "Content: short, long, image, video, link, file, collection, or unknown. Omit content to mean all content.",
  "name is required and at most 100 characters; icon is required and at most 50 characters. Never emit created_at; the server sets generated_at.",
  "Every unmappable request detail must be in mapping.unmapped with request, reason, and suggestion. Reasons are likes_unavailable, followers_not_authorable, unknown_content, or ambiguous.",
  "Likes cannot be filtered or sorted because Pubky does not model likes. Suggest exactly: Feeds can’t filter or sort by likes because Pubky does not model likes. Closest options: Popularity (bookmarks/reposts/replies) or Recent.",
  "Followers reach is not authorable by this App; preserve it in unmapped and suggest friends, following, wot, me, or all.",
  "Unknown content must be preserved in unmapped; do not silently convert it to a known kind.",
  "Use exact only when every request detail was represented, adjusted when a requested value was safely changed, and unsupported when it cannot be represented.",
  "If asked for people tagged X, express the supported equivalent as posts tagged X and explain that in name.",
  "Return every required field and return only JSON.",
].join(" ");
const FEED_MAX_OUTPUT_TOKENS = 1200;
const LIKES_COPY = "Feeds can’t filter or sort by likes because Pubky does not model likes. Closest options: Popularity (bookmarks/reposts/replies) or Recent.";
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

function utteranceMentionsUnknownContent(text: string): boolean {
  return /\bunknown\s+(?:content|post\s*type|kind)\b|\b(?:other|unsupported)\s+content\b/i.test(text);
}

function requestedEnum(text: string, values: readonly string[]): string | undefined {
  return values.find((value) => new RegExp(`\\b${value}\\b`, "i").test(text));
}

function unmapped(
  request: string,
  reason: "likes_unavailable" | "followers_not_authorable" | "unknown_content" | "ambiguous",
  suggestion: string,
) {
  return { request: request.slice(0, 200), reason, suggestion };
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
  const proposalVersion = rec?.proposal_version === 2 && pubchiFeedProposalV2Enabled();
  const updateId = typeof rec?.target_feed_id === "string" ? rec.target_feed_id : undefined;
  const currentFeed = asRecord(rec?.current_feed);
  const updateMode = Boolean(updateId && currentFeed);
  if (!proposalVersion && utteranceMentionsLikes(question)) return { ok: false, code: "FEED_UNSUPPORTED_LIKES", stage: "feed", cause: "likes" };
  if (!proposalVersion && utteranceMentionsFollowersReach(question)) {
    return { ok: false, code: "FEED_UNSUPPORTED_REACH", stage: "feed", cause: "followers_reach" };
  }

  const brainStarted = performance.now();
  const deadline = brainStarted + opts.tenant.budgets.per_request_wall_clock_ms;
  const requestLabels = {
    request_hash: createHash("sha256").update(question).digest("hex").slice(0, 16),
    request_len: String(question.length),
  };
  const ownerContext = renderOwnerContext(opts.ownerContext, "feed");
  const currentFeedPrompt = updateMode ? `\nCurrent App-loaded feed: ${JSON.stringify(currentFeed)}` : "";
  const modePrompt = !proposalVersion
    ? ""
    : updateMode
      ? `\nUse mode "update" and target_feed_id "${updateId}".`
      : "\nUse mode \"create\" and target_feed_id null.";
  const userContent = `${question}${currentFeedPrompt}${modePrompt}${ownerContext ? `\n\n${ownerContext}` : ""}`;
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
      consumedTokens += reportedUsageTokens(timed.usage) ?? estimateBrainTokens([
        { role: "system", content: FEED_SYSTEM },
        { role: "user", content },
      ], timed.text);
      return { ok: true, text: timed.text };
    } catch {
      consumedTokens += estimateBrainTokens([
        { role: "system", content: FEED_SYSTEM },
        { role: "user", content },
      ]);
      return { ok: false };
    }
  };
  const parse = (text: string): { ok: true; result: FeedProposalV1 | FeedProposalV2 } | { ok: false; cause: "json_parse" | "schema" | "unsupported_intent"; code?: ServiceErrorCode } => {
    let parsedJson: unknown;
    try {
      parsedJson = extractJson(text);
    } catch {
      return { ok: false, cause: "json_parse" };
    }
    const unsupported = asRecord(parsedJson)?.unsupported;
    if (proposalVersion) {
      const raw = asRecord(parsedJson);
      if (!raw) return { ok: false, cause: "schema" };
      const rawFeed = asRecord(raw.feed);
      const draft = rawFeed && "feed" in rawFeed
        ? { name: rawFeed.name, icon: rawFeed.icon, feed: rawFeed.feed }
        : { name: raw.name, icon: raw.icon, feed: raw.feed };
      const rawMapping = asRecord(raw.mapping);
      if (
        !rawMapping ||
        !["exact", "adjusted", "unsupported"].includes(String(rawMapping.status)) ||
        !Array.isArray(rawMapping.unmapped)
      ) return { ok: false, cause: "schema" };
      const draftChecked = FeedDraftV2Schema.safeParse(draft);
      if (!draftChecked.success) return { ok: false, cause: "schema" };
      const rawEntries = rawMapping.unmapped;
      const entries = rawEntries.filter((item): item is {
        request: string;
        reason: "likes_unavailable" | "followers_not_authorable" | "unknown_content" | "ambiguous";
        suggestion?: string;
      } => {
        const value = asRecord(item);
        return typeof value?.request === "string" &&
          ["likes_unavailable", "followers_not_authorable", "unknown_content", "ambiguous"].includes(String(value.reason)) &&
          (value.suggestion === undefined || typeof value.suggestion === "string");
      });
      if (entries.length !== rawEntries.length) return { ok: false, cause: "schema" };
      const normalizedEntries = entries.map((item) => ({
        request: item.request.slice(0, 200),
        reason: item.reason,
        ...(item.suggestion === undefined ? {} : { suggestion: item.suggestion.slice(0, 240) }),
      }));
      if (normalizedEntries.length > 20) return { ok: false, cause: "schema" };
      const entriesForMapping = normalizedEntries;
      if (utteranceMentionsLikes(question) && !entriesForMapping.some((item) => item.reason === "likes_unavailable")) {
        entriesForMapping.push(unmapped(question, "likes_unavailable", LIKES_COPY));
      }
      if (utteranceMentionsFollowersReach(question) && !entriesForMapping.some((item) => item.reason === "followers_not_authorable")) {
        entriesForMapping.push(unmapped(question, "followers_not_authorable", "Choose friends, following, wot, me, or all."));
      }
      if (utteranceMentionsUnknownContent(question) && !entriesForMapping.some((item) => item.reason === "unknown_content")) {
        entriesForMapping.push(unmapped(question, "unknown_content", "Omit content to include all content."));
      }
      if (draftChecked.data.feed.reach === "followers" && !entriesForMapping.some((item) => item.reason === "followers_not_authorable")) {
        entriesForMapping.push(unmapped("followers reach", "followers_not_authorable", "Choose friends, following, wot, me, or all."));
      }
      if (draftChecked.data.feed.content === "unknown" && !entriesForMapping.some((item) => item.reason === "unknown_content")) {
        entriesForMapping.push(unmapped("unknown content", "unknown_content", "Omit content to include all content."));
      }
      const feed = draftChecked.data.feed;
      const adjusted = (
        (requestedEnum(question, ["following", "followers", "friends", "all", "wot", "me"]) &&
          requestedEnum(question, ["following", "followers", "friends", "all", "wot", "me"]) !== feed.reach) ||
        (requestedEnum(question, ["recent", "popularity"]) && requestedEnum(question, ["recent", "popularity"]) !== feed.sort) ||
        (requestedEnum(question, ["columns", "wide", "visual", "list"]) && requestedEnum(question, ["columns", "wide", "visual", "list"]) !== feed.layout) ||
        (requestedEnum(question, ["short", "long", "image", "video", "link", "file", "collection", "unknown"]) &&
          requestedEnum(question, ["short", "long", "image", "video", "link", "file", "collection", "unknown"]) !== feed.content) ||
        entriesForMapping.some((item) => item.reason === "ambiguous")
      );
      const unsupported = entriesForMapping.some((item) =>
        (item.reason === "likes_unavailable" && utteranceMentionsLikes(question)) ||
        (item.reason === "followers_not_authorable" && feed.reach === "followers") ||
        (item.reason === "unknown_content" && feed.content === "unknown"),
      );
      const status = unsupported ? "unsupported" : adjusted || entriesForMapping.length > 0 ? "adjusted" : "exact";
      const proposal = {
        schema: "pubchi-feed-proposal" as const,
        version: 2 as const,
        bot: opts.tenant.bot,
        owner: opts.tenant.owner,
        generated_at: opts.now,
        mode: updateMode ? "update" as const : "create" as const,
        target_feed_id: updateId ?? null,
        feed: draftChecked.data,
        mapping: { status, unmapped: entriesForMapping },
        warnings: (Array.isArray(raw.warnings) ? raw.warnings : []).filter((warning): warning is string => typeof warning === "string").slice(0, 8),
        installed_user_feed_id: null,
      };
      const checked = parseFeedProposalV2(proposal);
      if (!checked.ok) return { ok: false, cause: "schema", code: checked.code };
      return { ok: true, result: checked.value };
    }
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
