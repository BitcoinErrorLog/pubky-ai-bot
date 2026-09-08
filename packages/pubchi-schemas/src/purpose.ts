import type { Tier } from "./tenant.js";

export const SERVED_PURPOSES = ["ask", "who-tagged-me", "build-feed"] as const;
export type ServedPurpose = (typeof SERVED_PURPOSES)[number];

export const PURPOSE_ENDPOINTS = {
  ask: "/v1/query",
  "who-tagged-me": "/v1/query",
  "build-feed": "/v1/feed",
} as const satisfies Record<ServedPurpose, `/v1/${string}`>;

export const PURPOSE_MINIMUM_TIER = {
  ask: "read-only",
  "who-tagged-me": "read-only",
  "build-feed": "read-only",
} as const satisfies Record<ServedPurpose, Tier>;
