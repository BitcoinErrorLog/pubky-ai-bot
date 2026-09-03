import { PubkySpecsBuilder } from "pubky-app-specs";

export const PROFILE_PATH = "/pub/pubky.app/profile.json";
export const BOT_PROFILE_NAME = "Jeb";
export const BOT_STATUS = "automated";
export const MAX_AVATAR_BYTES = 1024 * 1024;

export const BOT_PROFILE_BIO =
  "Automated account operated by Synonym. Answers public Pubky and graph questions when mentioned. Public data only; I can be wrong, correct me in the thread.";

export type ImageContentType = "image/png" | "image/jpeg" | "image/webp";

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

export interface AvatarPlan {
  blobPath: string;
  blobUrl: string;
  filePath: string;
  fileUrl: string;
  fileJson: Record<string, unknown>;
  bytes: Uint8Array;
  contentType: ImageContentType;
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

export function detectImageContentType(bytes: Uint8Array): ImageContentType {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  throw new Error("avatar must be PNG, JPEG, or WebP (detected from magic bytes)");
}

export function assertAvatarSize(bytes: Uint8Array): void {
  if (bytes.length === 0) throw new Error("avatar file is empty");
  if (bytes.length > MAX_AVATAR_BYTES) {
    throw new Error(`avatar exceeds ${MAX_AVATAR_BYTES} bytes (got ${bytes.length})`);
  }
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? Number(v) : v))) as Record<
    string,
    unknown
  >;
}

/**
 * Specs-only avatar plan: createBlob → blob URI, createFile(src=blob URI) → file URI.
 * Network PUT order (caller): putBytes(blob path, blob.data) then putJson(file path, file JSON).
 */
export function planAvatarUpload(botPk: string, bytes: Uint8Array, filename: string): AvatarPlan {
  assertAvatarSize(bytes);
  const contentType = detectImageContentType(bytes);
  const specs = new PubkySpecsBuilder(botPk);
  const blobResult = specs.createBlob(bytes);
  const fileResult = specs.createFile(filename, blobResult.meta.url, contentType, bytes.length);
  return {
    blobPath: blobResult.meta.path,
    blobUrl: blobResult.meta.url,
    filePath: fileResult.meta.path,
    fileUrl: fileResult.meta.url,
    fileJson: jsonRecord(fileResult.file.toJson()),
    bytes: blobResult.blob.data,
    contentType,
  };
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
