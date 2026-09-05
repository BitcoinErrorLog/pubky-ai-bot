/**
 * Graph paths from pubchi-design.md §3 and §5.
 * All durable Stage 4 state lives under bot identity B unless noted.
 */

export const PUBCHI_APP = "pubchi.app" as const;
export const PUBKY_APP = "pubky.app" as const;

export const PATHS = {
  manifest: "/pub/pubchi.app/manifest.json",
  config: "/pub/pubchi.app/config.json",
  interests: "/pub/pubchi.app/interests.json",
  formats: "/pub/pubchi.app/formats.json",
  whatIMissedCursor: "/pub/pubchi.app/cursors/what-i-missed.json",
  botProfile: "/pub/pubky.app/profile.json",
} as const;

export function feedDefinitionPath(feedId: string): string {
  return `/pub/pubchi.app/feeds/${feedId}.json`;
}

export function followerSnapshotPath(unixSeconds: number): string {
  return `/pub/pubchi.app/follower-snapshots/${unixSeconds}.json`;
}

export function requestBindingPath(requestId: string): string {
  return `/pub/pubchi.app/requests/${requestId}.json`;
}

export function suggestionPath(suggestionId: string): string {
  return `/pub/pubchi.app/suggestions/${suggestionId}.json`;
}

export function runReceiptPath(runId: string): string {
  return `/pub/pubchi.app/runs/${runId}.json`;
}

/** U → B reciprocal owner binding (written with U's session). */
export function ownerBindingPath(bot: string): string {
  return `/pub/pubchi.app/bots/${bot}.json`;
}

export function ownerBindingUri(owner: string, bot: string): string {
  return `pubky://${owner}${ownerBindingPath(bot)}`;
}

/**
 * B → U side: bot profile `automation.operator = U`.
 * Written with B's local session; not a second pubchi.app object.
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
    case PATHS.config:
    case PATHS.interests:
    case PATHS.formats:
    case PATHS.whatIMissedCursor:
      return true;
    default:
      break;
  }
  const feed = path.match(/^\/pub\/pubchi\.app\/feeds\/([^/]+)\.json$/);
  if (feed && FEED_ID.test(feed[1])) return true;
  const snap = path.match(/^\/pub\/pubchi\.app\/follower-snapshots\/([^/]+)\.json$/);
  if (snap && SNAPSHOT_ID.test(snap[1])) return true;
  const req = path.match(/^\/pub\/pubchi\.app\/requests\/([^/]+)\.json$/);
  if (req && REQUEST_ID.test(req[1])) return true;
  const sug = path.match(/^\/pub\/pubchi\.app\/suggestions\/([^/]+)\.json$/);
  if (sug && REQUEST_ID.test(sug[1])) return true;
  const run = path.match(/^\/pub\/pubchi\.app\/runs\/([^/]+)\.json$/);
  if (run && REQUEST_ID.test(run[1])) return true;
  const bind = path.match(/^\/pub\/pubchi\.app\/bots\/([^/]+)\.json$/);
  if (bind) return true;
  return false;
}

export const ALLOWLISTED_PATH_PATTERNS = [
  PATHS.manifest,
  PATHS.config,
  PATHS.interests,
  PATHS.formats,
  "/pub/pubchi.app/feeds/<feed-id>.json",
  "/pub/pubchi.app/follower-snapshots/<unix-seconds>.json",
  PATHS.whatIMissedCursor,
  "/pub/pubchi.app/requests/<request-id>.json",
  "/pub/pubchi.app/suggestions/<suggestion-id>.json",
  "/pub/pubchi.app/runs/<run-id>.json",
  "/pub/pubchi.app/bots/<bot>.json",
] as const;
