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
  })
  .strict();

export type PubchiEvidenceV1 = z.infer<typeof EvidenceSchema>;
export type PubchiAnswerV1 = z.infer<typeof PubchiAnswerV1Schema>;

export function parsePubchiAnswerV1(input: unknown): ParseResult<PubchiAnswerV1> {
  const parsed = fromZod(PubchiAnswerV1Schema, input);
  if (!parsed.ok) return parsed;
  for (const item of parsed.value.evidence) {
    const match = item.uri.match(PUBKY_URI);
    if (!match || !isPubkyId(match[1])) return err("URI_FORBIDDEN");
  }
  return ok(parsed.value);
}
