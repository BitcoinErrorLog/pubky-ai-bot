import { parseFeedProposalV1, type FeedProposalV1, type TenantV1 } from "../pubchi-schemas/index.js";
import type { Brain } from "../bot-kit/brain/types.js";
import type { ServiceErrorCode } from "./codes.js";

export type FeedOk = { ok: true; result: FeedProposalV1 };
export type FeedFail = { ok: false; code: ServiceErrorCode };
export type FeedOutcome = FeedOk | FeedFail;

const FEED_SYSTEM = [
  "Convert a natural-language Pubky feed request into one JSON object.",
  "Shape: {\"feed\":{\"tags\":string[],\"domain_tags\":string[],\"reach\":\"following\"|\"friends\"|\"all\"|\"wot\"|\"me\",\"layout\":\"columns\"|\"wide\"|\"visual\"|\"list\",\"sort\":\"recent\"|\"popularity\",\"content\":\"short\"|\"long\"|\"image\"|\"video\"|\"link\"|\"file\"|\"collection\"},\"name\":string,\"created_at\":unix_seconds}",
  "reach wot means two-hop / web of trust.",
  "Never emit likes, sort/content/reach/layout equal to likes, or reach followers.",
  "If the user asks for likes, reply exactly {\"unsupported\":\"likes\"}.",
  "If the user asks for followers reach, reply exactly {\"unsupported\":\"reach\"}.",
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

export async function runFeed(opts: {
  tenant: TenantV1;
  body: unknown;
  now: number;
  brain: Brain;
}): Promise<FeedOutcome> {
  const rec = asRecord(opts.body);
  const question =
    (typeof rec?.question === "string" && rec.question.trim()) ||
    (typeof rec?.utterance === "string" && rec.utterance.trim()) ||
    "";
  if (!question) return { ok: false, code: "SCHEMA_INVALID" };
  if (utteranceMentionsLikes(question)) return { ok: false, code: "FEED_UNSUPPORTED_LIKES" };
  if (utteranceMentionsFollowersReach(question)) return { ok: false, code: "FEED_UNSUPPORTED_REACH" };

  let text: string;
  try {
    const generated = await opts.brain.generate({
      messages: [
        { role: "system", content: FEED_SYSTEM },
        { role: "user", content: question },
      ],
      temperature: opts.brain.temperature,
      abortSignal: AbortSignal.timeout(opts.tenant.budgets.per_request_wall_clock_ms),
    });
    text = generated.text;
  } catch {
    return { ok: false, code: "BRAIN_UNAVAILABLE" };
  }

  let parsedJson: unknown;
  try {
    parsedJson = extractJson(text);
  } catch {
    return { ok: false, code: "FEED_SPECS_INVALID" };
  }
  const unsupported = asRecord(parsedJson)?.unsupported;
  if (unsupported === "likes") return { ok: false, code: "FEED_UNSUPPORTED_LIKES" };
  if (unsupported === "reach") return { ok: false, code: "FEED_UNSUPPORTED_REACH" };

  const feed = asRecord(parsedJson);
  if (!feed) return { ok: false, code: "FEED_SPECS_INVALID" };
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
  if (!checked.ok) return { ok: false, code: checked.code };
  return { ok: true, result: checked.value };
}
