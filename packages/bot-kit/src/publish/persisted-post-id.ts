import { timestampMsFromPostId } from "../crockford.js";

export class PersistedPostIdError extends Error {
  mentionKey: string;
  constructor(mentionKey: string, message: string) {
    super(`publish request ${mentionKey}: ${message}`);
    this.name = "PersistedPostIdError";
    this.mentionKey = mentionKey;
  }
}

/**
 * Collection upserts must keep a homeserver-stable id across edits, but a
 * historical sha256-hex replace_post_id is not a timestamp Crockford id and
 * must not be reused (it fails Nexus indexing and used to abort every upsert).
 */
export function reuseValidPersistedPostId(persisted: string | null | undefined, builtId: string): string {
  if (typeof persisted === "string" && timestampMsFromPostId(persisted) !== null) return persisted;
  return builtId;
}

export function requireValidPersistedPostId(mentionKey: string, persisted: string | null): string {
  if (!persisted || timestampMsFromPostId(persisted) === null) {
    throw new PersistedPostIdError(mentionKey, "existing replace_post_id is missing or invalid");
  }
  return persisted;
}
