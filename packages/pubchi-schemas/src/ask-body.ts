import { z } from "zod";
import { fromZod } from "./zod.js";
import type { ParseResult } from "./codes.js";
import { PubchiCitationSchema, type PubchiAnswerBasis } from "./answer.js";

const MAX_TURN_CODE_POINTS = 600;
const MAX_CONVERSATION_CODE_POINTS = 4_800;

function codePointLength(value: string): number {
  return Array.from(value).length;
}

export const ConversationTurnSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    text: z.string().refine((value) => codePointLength(value) <= MAX_TURN_CODE_POINTS, {
      message: `conversation turns must be at most ${MAX_TURN_CODE_POINTS} Unicode code points`,
    }),
    basis: z.enum(["graph", "knowledge", "model", "mixed"]).optional(),
    citations: z.array(PubchiCitationSchema).max(8).optional(),
  })
  .strict();

export const ConversationSchema = z
  .object({
    turns: z.array(ConversationTurnSchema).max(8),
  })
  .strict()
  .superRefine((conversation, ctx) => {
    let total = 0;
    for (const [index, turn] of conversation.turns.entries()) {
      total += codePointLength(turn.text);
      const expected = index % 2 === 0 ? "user" : "assistant";
      if (turn.role !== expected) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["turns", index, "role"],
          message: "conversation turns must alternate, starting with user",
        });
      }
    }
    if (total > MAX_CONVERSATION_CODE_POINTS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["turns"],
        message: `conversation must be at most ${MAX_CONVERSATION_CODE_POINTS} Unicode code points`,
      });
    }
  });

/** The existing ask body stays open; only the additive conversation field is strict. */
export const AskBodySchema = z
  .object({
    conversation: ConversationSchema.optional(),
  })
  .passthrough();

export type ConversationTurn = z.infer<typeof ConversationTurnSchema>;
export type Conversation = z.infer<typeof ConversationSchema>;
export type AskBody = z.infer<typeof AskBodySchema>;

export function parseAskBody(input: unknown): ParseResult<AskBody> {
  return fromZod(AskBodySchema, input);
}

export type ConversationBasis = PubchiAnswerBasis;
