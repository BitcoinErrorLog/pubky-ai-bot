import { getValidationLimits, PubkySpecsBuilder } from "pubky-app-specs";
import { ARTIFACT_TAG_VOCAB, REPLY_TAG_VOCABULARY } from "./reply-tags.js";
import { detectImageContentType, planFileUpload, type FileUploadPlan, type ImageContentType } from "./upload.js";

export const PROFILE_PATH = "/pub/pubky.app/profile.json";
export const BOT_PROFILE_NAME = "Jeb";
export const BOT_STATUS = "automated";
export const MAX_AVATAR_BYTES = 1024 * 1024;
export const HOW_I_WORK_LINK_TITLE = "How I work";
export const SOURCE_LINK_TITLE = "Source code";

export type { ImageContentType };
export type AvatarPlan = FileUploadPlan;
export { detectImageContentType };

export interface ProfileSpecLimits {
  nameMin: number;
  nameMax: number;
  bioMax: number;
  linksMax: number;
  linkTitleMax: number;
  linkUrlMax: number;
  statusMax: number;
}

export function profileSpecLimits(): ProfileSpecLimits {
  const l = getValidationLimits() as {
    userNameMinLength?: number;
    userNameMaxLength?: number;
    userBioMaxLength?: number;
    userLinksMaxCount?: number;
    userLinkTitleMaxLength?: number;
    userLinkUrlMaxLength?: number;
    userStatusMaxLength?: number;
  };
  return {
    nameMin: typeof l.userNameMinLength === "number" ? l.userNameMinLength : 3,
    nameMax: typeof l.userNameMaxLength === "number" ? l.userNameMaxLength : 50,
    bioMax: typeof l.userBioMaxLength === "number" ? l.userBioMaxLength : 160,
    linksMax: typeof l.userLinksMaxCount === "number" ? l.userLinksMaxCount : 5,
    linkTitleMax: typeof l.userLinkTitleMaxLength === "number" ? l.userLinkTitleMaxLength : 100,
    linkUrlMax: typeof l.userLinkUrlMaxLength === "number" ? l.userLinkUrlMaxLength : 300,
    statusMax: typeof l.userStatusMaxLength === "number" ? l.userStatusMaxLength : 50,
  };
}

/** Compact tag vocabulary for the profile bio. Length is asserted against spec bio max. */
export function compactTagBio(): string {
  const reply = REPLY_TAG_VOCABULARY.join(",");
  const artifact = ARTIFACT_TAG_VOCAB.join(",");
  const bio = `Automated account operated by Synonym. Mention me. Tags: ${reply}; ${artifact}.`;
  const { bioMax } = profileSpecLimits();
  if (bio.length > bioMax) {
    throw new Error(`generated profile bio exceeds spec userBioMaxLength (${bio.length} > ${bioMax})`);
  }
  return bio;
}

export const BOT_PROFILE_BIO = compactTagBio();

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
  const lim = profileSpecLimits();
  if (opts.name.length < lim.nameMin || opts.name.length > lim.nameMax) {
    throw new Error(`JEB_PROFILE_NAME must be ${lim.nameMin}–${lim.nameMax} characters (got ${opts.name.length})`);
  }
  if (opts.bio.length > lim.bioMax) {
    throw new Error(`JEB_PROFILE_BIO must be ≤ ${lim.bioMax} characters (got ${opts.bio.length})`);
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

/**
 * How I work post URI for the profile link.
 * Prefer `JEB_HOW_I_WORK_POST_URI`, then `JEB_POLICY_URL`, then a CLI value.
 * When `requested` is true (CLI `--how-i-work` present), a missing URI is a hard error.
 */
export function resolveHowIWorkPostUri(opts: {
  env?: NodeJS.ProcessEnv;
  cliUri?: string;
  requested?: boolean;
}): string | undefined {
  const env = opts.env ?? process.env;
  const cli = opts.cliUri?.trim();
  const fromEnv = (env.JEB_HOW_I_WORK_POST_URI ?? env.JEB_POLICY_URL)?.trim();
  const uri = cli || fromEnv || undefined;
  if (opts.requested && !uri) {
    throw new Error(
      "How I work post URI is required: set JEB_HOW_I_WORK_POST_URI or pass --how-i-work <uri> after publishing content/how-i-work.json",
    );
  }
  if (!uri) return undefined;
  if (!uri.startsWith("pubky://") && !uri.startsWith("https://") && !uri.startsWith("http://")) {
    throw new Error("How I work post URI must be a pubky:// or https:// URL");
  }
  const { linkUrlMax } = profileSpecLimits();
  if (uri.length > linkUrlMax) {
    throw new Error(`How I work post URI exceeds spec userLinkUrlMaxLength (${uri.length} > ${linkUrlMax})`);
  }
  return uri;
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
  const lim = profileSpecLimits();
  if (status && status.length > lim.statusMax) {
    throw new Error(`profile status exceeds spec userStatusMaxLength (${status.length} > ${lim.statusMax})`);
  }
  const specs = new PubkySpecsBuilder(botPk);
  const linkList: Array<{ title: string; url: string }> = [];
  if (links.sourceUrl) linkList.push({ title: SOURCE_LINK_TITLE, url: links.sourceUrl });
  if (links.policyUrl) linkList.push({ title: HOW_I_WORK_LINK_TITLE, url: links.policyUrl });
  if (linkList.length > lim.linksMax) {
    throw new Error(`profile links exceed spec userLinksMaxCount (${linkList.length} > ${lim.linksMax})`);
  }
  for (const link of linkList) {
    if (link.title.length > lim.linkTitleMax) {
      throw new Error(`profile link title exceeds spec userLinkTitleMaxLength (${link.title.length} > ${lim.linkTitleMax})`);
    }
    if (link.url.length > lim.linkUrlMax) {
      throw new Error(`profile link URL exceeds spec userLinkUrlMaxLength (${link.url.length} > ${lim.linkUrlMax})`);
    }
  }
  const { user, meta } = specs.createUser(name, bio, image, linkList.length ? linkList : null, status);
  return { json: user.toJson() as Record<string, unknown>, path: meta.path, url: meta.url };
}
