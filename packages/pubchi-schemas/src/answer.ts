import { z } from "zod";
import { err, ok, type ParseResult } from "./codes.js";
import { isPubkyId } from "./pubky.js";
import { fromZod, zPubky, zUnix, zVersion1 } from "./zod.js";

const PUBKY_URI = /^pubky:\/\/([ybndrfg8ejkmcpqxot1uwisza345h769]{52})\/.+$/;
const SOURCE_URI = /^(?:pubky:\/\/[ybndrfg8ejkmcpqxot1uwisza345h769]{52}\/.+|https:\/\/nexus[^/]*\/.+)$/;

const EvidenceSchema = z
  .object({
    kind: z.enum(["user", "post", "tag", "claim"]),
    label: z.string().min(1).max(80),
    uri: z.string(),
    claimants: z.array(zPubky).max(10),
    claimant_count: z.number().int().nonnegative().max(10_000),
    in_your_graph: z.boolean().nullable(),
  })
  .strict();

const ToolTraceSummarySchema = z
  .object({
    tools: z.array(z.string().max(16)).max(16),
    call_count: z.number().int().nonnegative().max(64),
    truncated: z.boolean(),
  })
  .strict();

const ContinuationSchema = z
  .object({
    since: z.string().datetime({ offset: true }),
    until: z.string().datetime({ offset: true }),
    complete: z.boolean(),
    skipped: z.number().int().nonnegative(),
  })
  .strict();

export const ExecutionScopeSchema = z
  .object({
    time: z
      .object({
        since_ms: z.number().int().nonnegative(),
        until_ms: z.number().int().nonnegative(),
        label: z.string().max(80),
        source: z.enum(["explicit", "default", "tool"]),
      })
      .strict()
      .nullable(),
    graph: z
      .object({
        kind: z.enum(["whole_graph", "owner_network", "none"]),
        hops: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
      })
      .strict(),
    filters: z.array(z.string().max(60)).max(10),
    complete: z.boolean(),
  })
  .strict();

export const PubchiAnswerV1Schema = z
  .object({
    schema: z.literal("pubchi-answer"),
    version: zVersion1,
    bot: zPubky,
    owner: zPubky,
    generated_at: zUnix,
    run_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    purpose: z.literal("ask"),
    question: z.string().min(1).max(500),
    summary: z.string().min(1).max(1200),
    evidence: z.array(EvidenceSchema).max(50),
    sources: z.array(z.string().regex(SOURCE_URI)).max(50),
    tool_trace_summary: ToolTraceSummarySchema,
    policy_version: z.literal(1),
    continuation: ContinuationSchema.optional(),
    scope: ExecutionScopeSchema.optional(),
  })
  .strict();

export type PubchiEvidenceV1 = z.infer<typeof EvidenceSchema>;
export type PubchiAnswerV1 = z.infer<typeof PubchiAnswerV1Schema>;
export type ExecutionScope = z.infer<typeof ExecutionScopeSchema>;

export function parsePubchiAnswerV1(input: unknown): ParseResult<PubchiAnswerV1> {
  const parsed = fromZod(PubchiAnswerV1Schema, input);
  if (!parsed.ok) return parsed;
  for (const item of parsed.value.evidence) {
    const match = item.uri.match(PUBKY_URI);
    if (!match || !isPubkyId(match[1])) return err("URI_FORBIDDEN");
  }
  return ok(parsed.value);
}
