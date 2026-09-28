export const AI_ROLE_PROFILE_DISCLOSURE =
  "AI role operated by Synonym; not a person or authority. Sources and policy are linked below.";

export const AI_PORTRAYAL_PROFILE_DISCLOSURE =
  "AI portrayal operated by Synonym; not the real person and not an authority or endorsement. Sources and policy are linked below.";

export const AI_ROLE_IDENTITY_DISCLOSURE =
  "I am an AI role operated by Synonym, not a person or an authority.";

export const AI_PORTRAYAL_IDENTITY_DISCLOSURE =
  "I am an AI portrayal operated by Synonym, not the real person and not an authority or endorsement.";

export const AI_ROLE_LONG_FORM_FOOTER =
  "AI role operated by Synonym. Pubky signatures identify the configured bot key; they do not establish personal or institutional authority.";

export const AI_PORTRAYAL_LONG_FORM_FOOTER =
  "AI portrayal operated by Synonym. Pubky signatures identify the configured bot key; they do not establish identity, endorsement, or authority.";

export type PersonaDisclosureKind = "role" | "portrayal";

export function profileDisclosure(kind: PersonaDisclosureKind): string {
  return kind === "portrayal" ? AI_PORTRAYAL_PROFILE_DISCLOSURE : AI_ROLE_PROFILE_DISCLOSURE;
}

export function identityDisclosure(kind: PersonaDisclosureKind): string {
  return kind === "portrayal" ? AI_PORTRAYAL_IDENTITY_DISCLOSURE : AI_ROLE_IDENTITY_DISCLOSURE;
}

export function longFormDisclosure(kind: PersonaDisclosureKind): string {
  return kind === "portrayal" ? AI_PORTRAYAL_LONG_FORM_FOOTER : AI_ROLE_LONG_FORM_FOOTER;
}
