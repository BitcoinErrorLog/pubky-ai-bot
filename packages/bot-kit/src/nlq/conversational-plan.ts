import { z } from "zod";
import { FULL_TOOLS, type AllowedTool } from "./intent.js";

export const Scope = z
  .object({
    window: z
      .object({
        since_ms: z.number().int().nonnegative(),
        until_ms: z.number().int().nonnegative(),
        source: z.enum(["explicit", "default"]),
        label: z.string().max(80),
      })
      .strict(),
    graph: z
      .object({
        kind: z.enum(["whole_graph", "owner_network"]),
        hops: z.number().int().min(1).max(3).optional(),
      })
      .strict(),
  })
  .strict();

export const Ref = z
  .object({
    from_step: z.string().regex(/^s[1-3]$/),
    path: z.enum(["users[0].pubky", "topics[0].label", "posts[0].uri", "sources[0].url", "sources[0].title", "results[0].url", "results[0].title"]),
  })
  .strict();

const Scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export const Value: z.ZodType<unknown> = z.lazy(() => z.union([Scalar, Ref, z.array(Value).max(50), z.record(Value)]));
const FeedSpec = z.record(z.string(), z.unknown());

export const TOOL_NAMES = [...FULL_TOOLS] as [AllowedTool, ...AllowedTool[]];
export const ToolName = z.enum(TOOL_NAMES);

export const Template = z
  .object({
    kind: z.literal("template"),
    tool: ToolName,
    params: z.record(Value),
    scope: Scope,
  })
  .strict();

export const Cypher = z
  .object({
    kind: z.literal("cypher"),
    query: z.string().max(2000),
    params: z.record(Value),
    rationale: z.string().min(1).max(240),
    scope: Scope,
  })
  .strict();

export const Knowledge = z
  .object({
    kind: z.literal("knowledge"),
    query: z.string().min(1).max(300),
    k: z.number().int().min(1).max(6).optional(),
  })
  .strict();

export const Web = z
  .object({
    kind: z.literal("web"),
    query: z.string().min(1).max(300),
    k: z.number().int().min(1).max(5).optional(),
  })
  .strict();

export const Answer = z
  .object({
    kind: z.literal("answer"),
    text: z.string().min(1).max(900),
    basis: z.enum(["model", "knowledge", "mixed"]),
    reason: z.enum(["conversational", "clarify", "out_of_scope"]),
    refs: z.array(Ref).max(8).optional(),
  })
  .strict();

export const Step = z
  .object({
    id: z.enum(["s1", "s2", "s3"]),
    action: z.discriminatedUnion("kind", [Template, Cypher, Knowledge, Web, Answer]),
  })
  .strict();

type LegacyConversationalPlan =
  | z.infer<typeof Template>
  | z.infer<typeof Cypher>
  | z.infer<typeof Knowledge>
  | z.infer<typeof Web>
  | {
      kind: "chain";
      steps: z.infer<typeof Step>[];
      scope: z.infer<typeof Scope>;
    }
  | z.infer<typeof Answer>
  | { kind: "feed"; spec: FeedPlan };

export const ConversationalPlan = (z
  .discriminatedUnion("kind", [
    Template,
    Cypher,
    Knowledge,
    Web,
    z
      .object({
        kind: z.literal("chain"),
        steps: z.array(Step).min(2).max(3),
        scope: Scope,
      })
      .strict(),
    Answer,
    z
      .object({
        kind: z.literal("feed"),
        spec: FeedSpec,
      })
      .strict(),
  ])
  .superRefine((plan, ctx) => {
    if (plan.kind !== "chain") {
      if (plan.kind === "template" || plan.kind === "cypher") {
        assertNoTenantParams(plan.params, ctx, ["params"]);
        assertPlanParamsWithinBounds(plan.params, ctx, ["params"]);
      }
      return;
    }
    const ids = new Set<string>();
    for (const [index, step] of plan.steps.entries()) {
      if (ids.has(step.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", index, "id"], message: "duplicate step id" });
      }
      ids.add(step.id);
      if ("params" in step.action) {
        assertNoTenantParams(step.action.params, ctx, ["steps", index, "action", "params"]);
        assertPlanParamsWithinBounds(step.action.params, ctx, ["steps", index, "action", "params"]);
      }
    }
    for (const [index, step] of plan.steps.entries()) {
      const refs = step.action.kind === "answer" ? step.action.refs ?? [] : "params" in step.action ? findRefs(step.action.params) : [];
      for (const ref of refs) {
        const sourceIndex = plan.steps.findIndex((candidate) => candidate.id === ref.from_step);
        if (sourceIndex < 0 || sourceIndex >= index) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", index], message: "references must point backward" });
          continue;
        }
        const source = plan.steps[sourceIndex].action;
        const manifest =
          source.kind === "template"
            ? TOOL_OUTPUT_MANIFESTS[source.tool]
            : source.kind === "knowledge" || source.kind === "web"
              ? ACTION_OUTPUT_MANIFESTS[source.kind]
              : CYPHER_OUTPUT_MANIFEST;
        if (!manifest.includes(ref.path)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", index], message: "reference path is not in source manifest" });
        }
      }
    }
  }) as unknown) as z.ZodType<LegacyConversationalPlan>;

export type ExecutionPlanScope = z.infer<typeof Scope>;
export type PlanRef = z.infer<typeof Ref>;
export type PlanValue = z.infer<typeof Value>;
export type FeedPlan = z.infer<typeof FeedSpec>;
/**
 * Existing planner/executor callers consume graph/feed plans in RA0. The
 * runtime schema above already accepts the additive retrieval actions; RA2
 * widens this compatibility type when it adds their executor.
 */
export type ConversationalPlan = LegacyConversationalPlan;
export type KnowledgeAction = z.infer<typeof Knowledge>;
export type WebAction = z.infer<typeof Web>;

export const TOOL_OUTPUT_MANIFESTS: Record<AllowedTool, readonly PlanRef["path"][]> = {
  get_post: [],
  get_thread: ["posts[0].uri"],
  get_user: [],
  get_user_tags: [],
  search_posts_by_tag: ["posts[0].uri"],
  get_post_replies: [],
  nexus_influencers: ["users[0].pubky"],
  search_posts: ["posts[0].uri"],
  scout_get_thread: ["posts[0].uri"],
  get_identity_summary: [],
  get_topic_brief: ["posts[0].uri"],
  get_what_changed: ["posts[0].uri"],
  get_what_did_i_miss: ["posts[0].uri"],
  get_related_posts: ["posts[0].uri"],
  get_relationship: [],
  get_tag_landscape: [],
  get_emerging_topics: ["topics[0].label"],
  get_debate_map: [],
  query_graph: [],
  search_users_by_name: ["users[0].pubky"],
  rank_users: ["users[0].pubky"],
  recommend_follows: ["users[0].pubky"],
  stale_follows: ["users[0].pubky"],
  follow_path: [],
  trust_view: [],
  top_posts: ["posts[0].uri"],
  mentions_of: ["posts[0].uri"],
  profile_card: [],
  search_web: [],
};

export const ACTION_OUTPUT_MANIFESTS = {
  knowledge: ["sources[0].url", "sources[0].title"],
  web: ["results[0].url", "results[0].title"],
} as const satisfies Record<"knowledge" | "web", readonly PlanRef["path"][]>;

export const CYPHER_OUTPUT_MANIFEST: readonly PlanRef["path"][] = [];

let tenantParamRejections = 0;

export function tenantParamRejectionCount(): number {
  return tenantParamRejections;
}

export function resetTenantParamRejectionCount(): void {
  tenantParamRejections = 0;
}

function findRefs(value: unknown): PlanRef[] {
  if (Ref.safeParse(value).success) return [value as PlanRef];
  if (Array.isArray(value)) return value.flatMap(findRefs);
  if (value && typeof value === "object") return Object.values(value).flatMap(findRefs);
  return [];
}

export function assertNoTenantParams(value: unknown, ctx?: z.RefinementCtx, path: (string | number)[] = []): void {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, nested] of Object.entries(value)) {
      if (["owner", "asker", "tenant"].includes(key)) {
        tenantParamRejections += 1;
        if (ctx) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, key], message: "tenant-bound params are service supplied" });
        else throw new Error(`tenant-bound param is not allowed: ${key}`);
      }
      assertNoTenantParams(nested, ctx, [...path, key]);
    }
  } else if (Array.isArray(value)) {
    value.forEach((nested, index) => assertNoTenantParams(nested, ctx, [...path, index]));
  }
}

function assertPlanParamsWithinBounds(value: unknown, ctx: z.RefinementCtx, path: (string | number)[]): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: "params must be JSON-serializable" });
    return;
  }
  if (serialized.length > 4096) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: "serialized params exceed 4096 bytes" });
  }
  const visit = (nested: unknown, depth: number, nestedPath: (string | number)[]): void => {
    if (Ref.safeParse(nested).success || nested === null || typeof nested !== "object") return;
    if (depth > 3) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: nestedPath, message: "value nesting exceeds depth 3" });
      return;
    }
    if (Array.isArray(nested)) {
      nested.forEach((item, index) => visit(item, depth + 1, [...nestedPath, index]));
      return;
    }
    Object.entries(nested).forEach(([key, item]) => visit(item, depth + 1, [...nestedPath, key]));
  };
  visit(value, 1, path);
}

