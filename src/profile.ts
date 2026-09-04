import { PubkySpecsBuilder } from "pubky-app-specs";
import { detectImageContentType, planFileUpload, type FileUploadPlan, type ImageContentType } from "./upload.js";

export const PROFILE_PATH = "/pub/pubky.app/profile.json";
export const BOT_PROFILE_NAME = "Jeb";
export const BOT_STATUS = "automated";
export const MAX_AVATAR_BYTES = 1024 * 1024;

export const BOT_PROFILE_BIO =
  "Automated account operated by Synonym. Answers public Pubky and graph questions when mentioned. Public data only; I can be wrong, correct me in the thread.";

export type { ImageContentType };
export type AvatarPlan = FileUploadPlan;
export { detectImageContentType };

export interface BotProfileLinks {
  sourceUrl?: string;
  policyUrl?: string;
}

export interface BotProfileFields {
  name?: string;
  bio?: string;
  status?: string | null;
  image?: string | null;
}

export interface BuiltProfile {
  json: Record<string, unknown>;
  path: string;
  url: string;
}

/** Operator-facing gate: the profile writer obeys the same write-path
 * switches as replies, and never runs in contract mode. */
export function assertProfilePublishAllowed(opts: { contractMode: boolean; repliesSwitchOn: boolean }): void {
  if (opts.contractMode) throw new Error("refusing to publish profile: JEB_CONTRACT_MODE=1");
  if (opts.repliesSwitchOn) throw new Error("refusing to publish profile: replies/global switch is on");
}

export function assertProfileCopy(opts: { name: string; bio: string }): void {
  if (opts.name.length < 3 || opts.name.length > 50) {
    throw new Error(`JEB_PROFILE_NAME must be 3–50 characters (got ${opts.name.length})`);
  }
  if (opts.bio.length > 160) {
    throw new Error(`JEB_PROFILE_BIO must be ≤ 160 characters (got ${opts.bio.length})`);
  }
}

export function profileCopyFromEnv(env: NodeJS.ProcessEnv = process.env): {
  name: string;
  bio: string;
  status: string | null;
} {
  const name = env.JEB_PROFILE_NAME?.trim() || BOT_PROFILE_NAME;
  const bio = env.JEB_PROFILE_BIO?.trim() || BOT_PROFILE_BIO;
  const statusRaw = env.JEB_PROFILE_STATUS;
  const status = statusRaw === undefined ? BOT_STATUS : statusRaw.trim() || null;
  assertProfileCopy({ name, bio });
  return { name, bio, status };
}

export function assertAvatarSize(bytes: Uint8Array): void {
  if (bytes.length === 0) throw new Error("avatar file is empty");
  if (bytes.length > MAX_AVATAR_BYTES) {
    throw new Error(`avatar exceeds ${MAX_AVATAR_BYTES} bytes (got ${bytes.length})`);
  }
}

/**
 * Specs-only avatar plan: createBlob → blob URI, createFile(src=blob URI) → file URI.
 * Network PUT order (caller): putBytes(blob path, blob.data) then putJson(file path, file JSON).
 */
export function planAvatarUpload(botPk: string, bytes: Uint8Array, filename: string): AvatarPlan {
  return planFileUpload(botPk, bytes, filename, { maxBytes: MAX_AVATAR_BYTES, label: "avatar" });
}

/**
 * Build and validate the transparent bot profile via pubky-app-specs
 * (PubkySpecsBuilder.createUser). Throws if the spec validation rejects
 * the object, so an invalid profile can never reach the homeserver.
 */
export function buildBotProfile(botPk: string, links: BotProfileLinks, fields: BotProfileFields = {}): BuiltProfile {
  const name = fields.name ?? BOT_PROFILE_NAME;
  const bio = fields.bio ?? BOT_PROFILE_BIO;
  const status = fields.status === undefined ? BOT_STATUS : fields.status;
  const image = fields.image ?? null;
  assertProfileCopy({ name, bio });
  const specs = new PubkySpecsBuilder(botPk);
  const linkList: Array<{ title: string; url: string }> = [];
  if (links.sourceUrl) linkList.push({ title: "Source code", url: links.sourceUrl });
  if (links.policyUrl) linkList.push({ title: "How I work", url: links.policyUrl });
  const { user, meta } = specs.createUser(name, bio, image, linkList.length ? linkList : null, status);
  return { json: user.toJson() as Record<string, unknown>, path: meta.path, url: meta.url };
}
