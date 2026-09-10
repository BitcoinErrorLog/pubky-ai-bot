import { z } from "zod";

const ContextSchema = z.union([
  z.literal("none"),
  z.object({
    about: z.string().max(1500).optional(),
    instructions: z.string().max(1000).optional(),
  }).strict(),
]);

const ExpectedSchema = z.object({
  plan_kind: z.enum(["template", "cypher", "chain", "answer", "feed"]),
  tool: z.string().min(1).optional(),
  chain_shape: z.array(z.string().min(1)).min(2).max(3).optional(),
  scope: z.object({
    window_days: z.union([z.number().int().nonnegative(), z.literal("all_time")]),
    graph: z.enum(["whole_graph", "owner_network", "none"]),
  }).strict().optional(),
}).strict();

export const GoldenCaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  question: z.string().min(1).max(500),
  context: ContextSchema,
  now_ms: z.number().int().nonnegative(),
  schema_hash: z.string().min(1),
  expected: ExpectedSchema,
  acceptance: z.array(z.enum([
    "uses_fast_path",
    "uses_expected_tool",
    "uses_expected_chain",
    "scope_is_truthful",
    "returns_answer_or_refusal",
  ])).min(1),
}).strict();

export const GoldenSetSchema = z.array(GoldenCaseSchema);
export type GoldenCase = z.infer<typeof GoldenCaseSchema>;
