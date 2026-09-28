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

const RepositoryPathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !value.startsWith("/") && !value.split("/").includes(".."), {
    message: "must be a repository-relative path without '..'",
  });

export const PersonaManifestSchema = z
  .object({
    schema_version: z.literal(PERSONA_SCHEMA_VERSION),
    id: SlugSchema,
    version: SemverSchema,
    identity: z
      .object({
        display_name: z.string().min(1).max(80),
        operator: z.literal("Synonym"),
        profile_template: RepositoryPathSchema,
        policy_url: z.string().url(),
      })
      .strict(),
    disclosure: z
      .object({
        kind: z.enum(["role", "portrayal"]),
      })
      .strict(),
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
  .superRefine((manifest, ctx) => {
    if (new Set(manifest.capabilities.allow).size !== manifest.capabilities.allow.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capabilities", "allow"],
        message: "capability ids must be unique",
      });
    }
  });

export type PersonaManifest = z.infer<typeof PersonaManifestSchema>;
