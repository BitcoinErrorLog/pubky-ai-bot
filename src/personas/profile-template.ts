import { z } from "zod";
import { profileSpecLimits } from "../profile.js";
import { profileDisclosure, type PersonaDisclosureKind } from "./disclosure.js";

const limits = profileSpecLimits();

export const PersonaProfileTemplateSchema = z
  .object({
    name: z.string().min(limits.nameMin).max(limits.nameMax),
    bio: z.string().min(1).max(limits.bioMax),
    status: z.literal("automated"),
    disclosure_kind: z.enum(["role", "portrayal"]),
  })
  .strict()
  .superRefine((template, ctx) => {
    const required = profileDisclosure(template.disclosure_kind);
    if (template.bio !== required) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["bio"],
        message: `must equal the platform ${template.disclosure_kind} disclosure`,
      });
    }
  });

export type PersonaProfileTemplate = z.infer<typeof PersonaProfileTemplateSchema>;

export function buildProfileTemplate(name: string, kind: PersonaDisclosureKind): PersonaProfileTemplate {
  return PersonaProfileTemplateSchema.parse({
    name,
    bio: profileDisclosure(kind),
    status: "automated",
    disclosure_kind: kind,
  });
}
