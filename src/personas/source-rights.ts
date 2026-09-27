import { z } from "zod";

export const SOURCE_RIGHTS_STATUSES = [
  "public_domain",
  "permissive_license",
  "separately_cleared",
  "review_only",
  "excluded",
] as const;

export const SOURCE_ALLOWED_USES = [
  "retrieval",
  "minimal_quotation",
  "evaluation",
  "training",
] as const;

export const SourceRightsRecordSchema = z
  .object({
    schema_version: z.literal(1),
    source_id: z.string().min(1).max(128).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    title: z.string().min(1).max(500),
    author: z.string().min(1).max(300),
    work_date: z.string().min(1).max(100),
    edition: z.string().min(1).max(300).nullable(),
    translator: z.string().min(1).max(300).nullable(),
    source_url: z.string().url(),
    retrieved_at: z.string().datetime({ offset: true }),
    license: z.string().min(1).max(500),
    jurisdiction: z.string().min(1).max(200),
    rights_status: z.enum(SOURCE_RIGHTS_STATUSES),
    allowed_uses: z.array(z.enum(SOURCE_ALLOWED_USES)).max(SOURCE_ALLOWED_USES.length),
    reviewed_by: z.string().min(1).max(200),
    reviewed_at: z.string().datetime({ offset: true }),
    notes: z.string().max(2_000).nullable(),
  })
  .strict()
  .superRefine((record, ctx) => {
    if (new Set(record.allowed_uses).size !== record.allowed_uses.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["allowed_uses"],
        message: "allowed uses must be unique",
      });
    }
    if (
      (record.rights_status === "review_only" || record.rights_status === "excluded") &&
      (record.allowed_uses.includes("retrieval") || record.allowed_uses.includes("training"))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["allowed_uses"],
        message: `${record.rights_status} material cannot be used for retrieval or training`,
      });
    }
    if (record.allowed_uses.includes("training") && record.rights_status === "public_domain") {
      return;
    }
    if (
      record.allowed_uses.includes("training") &&
      !["permissive_license", "separately_cleared"].includes(record.rights_status)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["allowed_uses"],
        message: "training requires public-domain, permissively licensed, or separately cleared material",
      });
    }
  });

export type SourceRightsRecord = z.infer<typeof SourceRightsRecordSchema>;
