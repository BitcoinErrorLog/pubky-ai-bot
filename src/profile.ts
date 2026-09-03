import { PubkySpecsBuilder } from "pubky-app-specs";

export const PROFILE_PATH = "/pub/pubky.app/profile.json";
export const BOT_PROFILE_NAME = "Jeb";
export const BOT_STATUS = "automated";

export const BOT_PROFILE_BIO =
  "Automated account operated by Synonym. Answers public Pubky and graph questions when mentioned. Public data only; I can be wrong, correct me in the thread.";

export interface BotProfileLinks {
  sourceUrl?: string;
  policyUrl?: string;
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

/**
 * Build and validate the transparent bot profile via pubky-app-specs
 * (PubkySpecsBuilder.createUser). Throws if the spec validation rejects
 * the object, so an invalid profile can never reach the homeserver.
 */
export function buildBotProfile(botPk: string, links: BotProfileLinks): BuiltProfile {
  const specs = new PubkySpecsBuilder(botPk);
  const linkList: Array<{ title: string; url: string }> = [];
  if (links.sourceUrl) linkList.push({ title: "Source code", url: links.sourceUrl });
  if (links.policyUrl) linkList.push({ title: "How I work", url: links.policyUrl });
  const { user, meta } = specs.createUser(
    BOT_PROFILE_NAME,
    BOT_PROFILE_BIO,
    null,
    linkList.length ? linkList : null,
    BOT_STATUS,
  );
  return { json: user.toJson() as Record<string, unknown>, path: meta.path, url: meta.url };
}
