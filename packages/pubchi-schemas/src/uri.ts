import { parseUri, ValidationError } from "pubky-social-specs";

/** Social objects the App can show as public evidence. Private feeds, mutes and bookmarks stay local. */
export function parsePublicSocialUri(uri: string) {
  if (!uri.startsWith("pubky://")) return null;
  try {
    const parsed = parseUri(uri);
    if (parsed.root !== "public" || !parsed.path) return null;
    switch (parsed.kind) {
      case "user":
      case "post":
      case "tag":
      case "follow":
      case "file":
        return parsed;
      default:
        return null;
    }
  } catch (error) {
    if (error instanceof ValidationError) return null;
    throw error;
  }
}

export function parsePubchiTarget(target: { kind: "post" | "user"; uri: string }) {
  const parsed = parsePublicSocialUri(target.uri);
  if (parsed?.kind === "user" && target.kind === "user") return { kind: parsed.kind, owner: parsed.owner };
  if (parsed?.kind === "post" && target.kind === "post" && !parsed.editId) {
    return { kind: parsed.kind, owner: parsed.owner, id: parsed.id };
  }
  return null;
}

export function isPubchiPostUri(uri: string): boolean {
  return parsePubchiTarget({ kind: "post", uri }) !== null;
}
