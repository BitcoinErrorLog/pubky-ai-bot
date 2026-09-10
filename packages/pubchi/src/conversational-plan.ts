import { z } from "zod";
import { ConversationalPlan, type ConversationalPlan as ConversationalPlanValue } from "../bot-kit/nlq/conversational-plan.js";
import { FeedDraftV2Schema } from "../pubchi-schemas/feed.js";

export type PubchiPlanParseResult =
  | { success: true; data: ConversationalPlanValue }
  | { success: false; error: z.ZodError };

export function parseConversationalPlanForPubchi(input: unknown): PubchiPlanParseResult {
  const parsed = ConversationalPlan.safeParse(input);
  if (!parsed.success) return parsed;
  if (parsed.data.kind !== "feed") return parsed;
  const feed = FeedDraftV2Schema.safeParse(parsed.data.spec);
  if (feed.success) return { success: true, data: { ...parsed.data, spec: feed.data } };
  return { success: false, error: feed.error };
}
