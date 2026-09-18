/**
 * Durable Pubchi state lives under owner identity U.
 */

export const PUBCHI_APP = "app.pubchi" as const;
export const PUBCHI_EPOCH = "v1" as const;
export const PUBKY_APP = "pubky.app" as const;

export const PATHS = {
  manifest: `/pub/${PUBCHI_APP}/${PUBCHI_EPOCH}/manifest.json`,
  bot: `/pub/${PUBCHI_APP}/${PUBCHI_EPOCH}/bot.json`,
  config: `/pub/${PUBCHI_APP}/${PUBCHI_EPOCH}/config.json`,
  interests: `/pub/${PUBCHI_APP}/${PUBCHI_EPOCH}/interests.json`,
  formats: `/pub/${PUBCHI_APP}/${PUBCHI_EPOCH}/formats.json`,
  whatIMissedCursor: `/pub/${PUBCHI_APP}/${PUBCHI_EPOCH}/cursors/what-i-missed.json`,
  botProfile: "/pub/pubky.app/profile.json",
} as const;

export function feedDefinitionPath(feedId: string): string {
  return `/pub/${PUBCHI_APP}/${PUBCHI_EPOCH}/feeds/${feedId}.json`;
}

export function followerSnapshotPath(unixSeconds: number): string {
  return `/pub/${PUBCHI_APP}/${PUBCHI_EPOCH}/follower-snapshots/${unixSeconds}.json`;
}

export function requestBindingPath(requestId: string): string {
  return `/pub/${PUBCHI_APP}/${PUBCHI_EPOCH}/requests/${requestId}.json`;
}

export function suggestionPath(suggestionId: string): string {
  return `/pub/${PUBCHI_APP}/${PUBCHI_EPOCH}/suggestions/${suggestionId}.json`;
}

export function runReceiptPath(runId: string): string {
  return `/pub/${PUBCHI_APP}/${PUBCHI_EPOCH}/runs/${runId}.json`;
}

/** U → B reciprocal owner binding (written with U's session). */
export function ownerBindingPath(bot: string): string {
  return `/pub/${PUBCHI_APP}/${PUBCHI_EPOCH}/bots/${bot}.json`;
}

export function ownerBindingUri(owner: string, bot: string): string {
  return `pubky://${owner}${ownerBindingPath(bot)}`;
}

export function ownerObjectUri(owner: string, path: string): string {
  return `pubky://${owner}${path}`;
}

export function botUri(owner: string): string {
  return ownerObjectUri(owner, PATHS.bot);
}

export function configUri(owner: string): string {
  return ownerObjectUri(owner, PATHS.config);
}

/**
 * B → U side: bot profile `automation.operator = U`.
 * Written with B's local session; not a second app.pubchi object.
 */
export function botProfileUri(bot: string): string {
  return `pubky://${bot}${PATHS.botProfile}`;
}

export function botObjectUri(bot: string, path: string): string {
  return `pubky://${bot}${path}`;
}

const FEED_ID = /^[A-Za-z0-9_-]{1,64}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SNAPSHOT_ID = /^[0-9]{1,16}$/;

/** Stage 4 allowlist. Rejects `..`, encoded slashes, queries, foreign pubkys. */
export function isAllowlistedPath(path: string): boolean {
  if (path.includes("..") || path.includes("%") || path.includes("?") || path.includes("pubky://")) {
    return false;
  }
  if (path.includes("//") || path.includes("\\")) return false;
  switch (path) {
    case PATHS.manifest:
    case PATHS.bot:
    case PATHS.config:
    case PATHS.interests:
    case PATHS.formats:
    case PATHS.whatIMissedCursor:
      return true;
    default:
      break;
  }
  const feed = path.match(new RegExp(`^/pub/${PUBCHI_APP.replace(".", "\\.")}/${PUBCHI_EPOCH}/feeds/([^/]+)\\.json$`));
  if (feed && FEED_ID.test(feed[1])) return true;
  const snap = path.match(new RegExp(`^/pub/${PUBCHI_APP.replace(".", "\\.")}/${PUBCHI_EPOCH}/follower-snapshots/([^/]+)\\.json$`));
  if (snap && SNAPSHOT_ID.test(snap[1])) return true;
  const req = path.match(new RegExp(`^/pub/${PUBCHI_APP.replace(".", "\\.")}/${PUBCHI_EPOCH}/requests/([^/]+)\\.json$`));
  if (req && REQUEST_ID.test(req[1])) return true;
  const sug = path.match(new RegExp(`^/pub/${PUBCHI_APP.replace(".", "\\.")}/${PUBCHI_EPOCH}/suggestions/([^/]+)\\.json$`));
  if (sug && REQUEST_ID.test(sug[1])) return true;
  const run = path.match(new RegExp(`^/pub/${PUBCHI_APP.replace(".", "\\.")}/${PUBCHI_EPOCH}/runs/([^/]+)\\.json$`));
  if (run && REQUEST_ID.test(run[1])) return true;
  const bind = path.match(new RegExp(`^/pub/${PUBCHI_APP.replace(".", "\\.")}/${PUBCHI_EPOCH}/bots/([^/]+)\\.json$`));
  if (bind && REQUEST_ID.test(bind[1])) return true;
  const device = path.match(new RegExp(`^/pub/${PUBCHI_APP.replace(".", "\\.")}/${PUBCHI_EPOCH}/devices/([^/]+)\\.json$`));
  if (device && REQUEST_ID.test(device[1])) return true;
  return false;
}

/** Ordered to match the Pubky App contract list; order does not affect matching. */
export const ALLOWLISTED_PATH_PATTERNS = [
  "/pub/app.pubchi/v1/manifest.json",
  "/pub/app.pubchi/v1/bot.json",
  "/pub/app.pubchi/v1/config.json",
  "/pub/app.pubchi/v1/interests.json",
  "/pub/app.pubchi/v1/formats.json",
  "/pub/app.pubchi/v1/feeds/<feed-id>.json",
  "/pub/app.pubchi/v1/follower-snapshots/<unix-seconds>.json",
  "/pub/app.pubchi/v1/cursors/what-i-missed.json",
  "/pub/app.pubchi/v1/requests/<request-id>.json",
  "/pub/app.pubchi/v1/suggestions/<suggestion-id>.json",
  "/pub/app.pubchi/v1/runs/<run-id>.json",
  "/pub/app.pubchi/v1/bots/<bot>.json",
  "/pub/app.pubchi/v1/devices/<device>.json",
] as const;
