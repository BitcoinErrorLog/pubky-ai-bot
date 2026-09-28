import { z } from "zod";

export const PERSONA_SCHEMA_VERSION = 1 as const;

export const CAPABILITY_IDS = [
  "nexus_read",
  "scout_graph",
  "knowledge_global",
  "web_search",
  "image_read",
  "tags",
  "translate",
  "evidence_map",
] as const;

export type CapabilityId = (typeof CAPABILITY_IDS)[number];
export const CapabilityIdSchema = z.enum(CAPABILITY_IDS);

const SlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "must be a lowercase kebab-case slug");

const SemverSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/, "must be semantic version");

const BundlePathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !value.startsWith("/") && !value.split("/").includes(".."), {
    message: "must be a bundle-relative path without '..'",
  });

/** Identity-free and portable across Jeb, Pubchi, and future runtimes. */
export const PersonaPackSchema = z
  .object({
    schema_version: z.literal(PERSONA_SCHEMA_VERSION),
    id: SlugSchema,
    version: SemverSchema,
    disclosure: z.object({ kind: z.enum(["role", "portrayal"]) }).strict(),
    corpus_namespace: z
      .string()
      .min(1)
      .max(192)
      .regex(/^(?:global|persona\/[a-z0-9]+(?:-[a-z0-9]+)*\/[^/\s]+)$/),
    voice: z
      .object({
        assistant_role_label: z.string().min(1).max(80),
        intro_line: z.string().min(1).max(1_000).refine(
          (value) => value.includes("{bot_pk}"),
          "must contain the {bot_pk} placeholder",
        ),
      })
      .strict(),
    capabilities: z
      .object({
        allow: z.array(CapabilityIdSchema).min(1).max(CAPABILITY_IDS.length),
      })
      .strict(),
  })
  .strict()
  .superRefine((pack, ctx) => {
    if (
      pack.corpus_namespace !== "global" &&
      pack.corpus_namespace !== `persona/${pack.id}/${pack.version}`
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["corpus_namespace"],
        message: "must be global or match this pack id and version",
      });
    }
    if (new Set(pack.capabilities.allow).size !== pack.capabilities.allow.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capabilities", "allow"],
        message: "capability ids must be unique",
      });
    }
  });

/** Operator-owned account/profile attachment for one pack version. */
export const PersonaBindingSchema = z
  .object({
    schema_version: z.literal(PERSONA_SCHEMA_VERSION),
    persona_id: SlugSchema,
    pack_version: SemverSchema,
    identity: z
      .object({
        display_name: z.string().min(1).max(80),
        operator: z.literal("Synonym"),
        profile_template: BundlePathSchema,
        policy_url: z.string().url(),
      })
      .strict(),
    budgets: z
      .object({
        daily_tokens: z.number().int().positive(),
        per_user_daily_tokens: z.number().int().positive(),
        web_calls_per_mention: z.number().int().nonnegative(),
        web_calls_daily: z.number().int().nonnegative(),
        scout_calls_per_mention: z.number().int().nonnegative(),
        scout_calls_daily: z.number().int().nonnegative(),
        image_tokens_daily: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict()
  .superRefine((binding, ctx) => {
    if (binding.budgets.per_user_daily_tokens > binding.budgets.daily_tokens) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["budgets", "per_user_daily_tokens"],
        message: "must not exceed daily_tokens",
      });
    }
  });

export type PersonaPack = z.infer<typeof PersonaPackSchema>;
export type PersonaBinding = z.infer<typeof PersonaBindingSchema>;
