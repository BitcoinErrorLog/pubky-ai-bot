import { z } from "zod";

export const PERSONA_SCHEMA_VERSION = 1 as const;

export const CAPABILITY_IDS = [
  "nexus_read",
  "scout_graph",
  "raw_scout_query",
  "knowledge_global",
  "knowledge_persona",
  "web_search",
  "image_read",
  "tags",
  "translate",
  "evidence_map",
  "code_review",
  "ux_critique",
  "coaching_plan",
  "steelman_debate",
  "source_authentication",
  "simulation",
  "standalone_publish",
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

const RepositoryPathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !value.startsWith("/") && !value.split("/").includes(".."), {
    message: "must be a repository-relative path without '..'",
  });

const TagLabelSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "must be a lowercase hyphenated label");

export const PersonaManifestSchema = z
  .object({
    schema_version: z.literal(PERSONA_SCHEMA_VERSION),
    id: SlugSchema,
    version: SemverSchema,
    identity: z
      .object({
        display_name: z.string().min(1).max(80),
        operator: z.literal("Synonym"),
        kind: z.enum(["role", "portrayal"]),
        profile_template: RepositoryPathSchema,
        policy_url: z.string().url(),
      })
      .strict(),
    voice: z
      .object({
        spec: RepositoryPathSchema,
        eval_set: RepositoryPathSchema,
      })
      .strict(),
    expertise: z
      .object({
        corpus_manifest: RepositoryPathSchema,
        rights_manifest: RepositoryPathSchema,
        retrieval_namespace: z
          .string()
          .min(1)
          .max(192)
          .regex(/^persona\/[a-z0-9]+(?:-[a-z0-9]+)*\/[^/\s]+$/, "must be persona/<id>/<version>"),
      })
      .strict(),
    capabilities: z
      .object({
        allow: z.array(CapabilityIdSchema).min(1).max(CAPABILITY_IDS.length),
        deny: z.array(CapabilityIdSchema).max(CAPABILITY_IDS.length),
      })
      .strict(),
    tags: z
      .object({
        reply_vocabulary: z.array(TagLabelSchema).min(1).max(128),
        artifact_vocabulary: z.array(TagLabelSchema).min(1).max(128),
        max_per_target: z.number().int().min(1).max(5),
      })
      .strict(),
    safety: z
      .object({
        portrayal_disclosure: z.literal("required"),
        real_person_claim: z.literal("forbidden"),
        authority_claim: z.literal("forbidden"),
      })
      .strict(),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    if (new Set(manifest.capabilities.allow).size !== manifest.capabilities.allow.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capabilities", "allow"],
        message: "capability ids must be unique",
      });
    }
    if (new Set(manifest.capabilities.deny).size !== manifest.capabilities.deny.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capabilities", "deny"],
        message: "capability ids must be unique",
      });
    }
    if (manifest.expertise.retrieval_namespace !== `persona/${manifest.id}/${manifest.version}`) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expertise", "retrieval_namespace"],
        message: "must exactly match persona/<id>/<version>",
      });
    }
  });

export type PersonaManifest = z.infer<typeof PersonaManifestSchema>;
