import {
  RESOURCE_PILOT_BOT_PK,
  STAGING_HOMESERVER_HOST,
  STAGING_HOMESERVER_PK,
} from "./outbound-gate.js";
import { RESOURCE_CONFIG_VERSION } from "./resource-taxonomy.js";
import { DEFAULT_RESOURCE_APP } from "./resource-publish.js";
import { JEB_PUBKY } from "./weekly/types.js";

export type ResourceTarget = "staging" | "production";

/**
 * Version of the whole pin set below. It is copied into the build stamp, so
 * editing any pin without bumping this is a stamp mismatch at runtime rather
 * than a silently different write target.
 */
export const RESOURCE_PIN_SET_VERSION = "resource-pins-v1-jeb-tags";

/**
 * Production homeserver public key. Independently corroborated in this repo by
 * `src/test-fixtures/production-homeserver-pkdns.json`, a captured read-only
 * PKDNS resolution of Jeb's own identity; `resource-target-profile.test.ts`
 * fails if the two ever disagree, and `docs/production-gate.md` records the
 * command to re-resolve it. Public keys are identifiers, not key material.
 */
export const PRODUCTION_HOMESERVER_PK = "8um71us3fyw6h8wbcxb5ar3rwusy1a6u49956ikzojg3gcwd1dty";

/** Only this host may receive universal-tag writes on the production target. */
export const PRODUCTION_HOMESERVER_HOST = "homeserver.pubky.app";

/**
 * The pubkyauth relay the scoped self-approval channel runs over. Pinned per
 * target instead of relying on the SDK default, which is an implicit URL in
 * the write path. `resource-target-profile.test.ts` asserts this value is
 * byte-identical to the default compiled into the installed SDK, so pinning
 * changes nothing operationally while removing the implicit dependency.
 *
 * A hostile relay is an availability problem, not an authority one: the
 * AuthToken is signed by Jeb and encrypted to the channel, so a relay can drop
 * an approval but cannot forge one. It is never read from the environment.
 */
export const PUBKYAUTH_RELAY_URL = "https://httprelay.pubky.app/link";

/**
 * Signed-off release identifier a production resource run must present in
 * `JEB_RESOURCE_CONFIG_VERSION`. It differs operationally from the staging
 * default so a staging value can never satisfy the production gate.
 */
export const PRODUCTION_RESOURCE_CONFIG_VERSION = "external-resources-v3-bitcoin-canon-prod-1";

export interface ResourceTargetProfile {
  readonly target: ResourceTarget;
  /** Sole Nexus base URL for this target; `JEB_NEXUS_URL` is ignored. */
  readonly nexusUrl: string;
  readonly homeserverPk: string;
  readonly homeserverHost: string;
  /** The only identity allowed to publish resource tags on this target. */
  readonly publisherPk: string;
  readonly authRelayUrl: string;
  /** Exact `JEB_RESOURCE_CONFIG_VERSION` this target accepts. */
  readonly signedConfigVersion: string;
  /** Capability scope the resource session may hold, and nothing broader. */
  readonly tagCapabilityScope: string;
  readonly pinSetVersion: string;
}

function tagScope(app: string): string {
  return `/pub/${app}/tags/`;
}

export const STAGING_RESOURCE_PROFILE: ResourceTargetProfile = Object.freeze({
  target: "staging",
  nexusUrl: "https://nexus.staging.pubky.app",
  homeserverPk: STAGING_HOMESERVER_PK,
  homeserverHost: STAGING_HOMESERVER_HOST,
  publisherPk: RESOURCE_PILOT_BOT_PK,
  authRelayUrl: PUBKYAUTH_RELAY_URL,
  signedConfigVersion: RESOURCE_CONFIG_VERSION,
  tagCapabilityScope: tagScope(DEFAULT_RESOURCE_APP),
  pinSetVersion: RESOURCE_PIN_SET_VERSION,
});

export const PRODUCTION_RESOURCE_PROFILE: ResourceTargetProfile = Object.freeze({
  target: "production",
  nexusUrl: "https://nexus.pubky.app",
  homeserverPk: PRODUCTION_HOMESERVER_PK,
  homeserverHost: PRODUCTION_HOMESERVER_HOST,
  publisherPk: JEB_PUBKY,
  authRelayUrl: PUBKYAUTH_RELAY_URL,
  signedConfigVersion: PRODUCTION_RESOURCE_CONFIG_VERSION,
  tagCapabilityScope: tagScope(DEFAULT_RESOURCE_APP),
  pinSetVersion: RESOURCE_PIN_SET_VERSION,
});

const PROFILES: Record<ResourceTarget, ResourceTargetProfile> = {
  staging: STAGING_RESOURCE_PROFILE,
  production: PRODUCTION_RESOURCE_PROFILE,
};

/** Sole source of URLs and public keys for a resource run. */
export function resourceTargetProfile(target: ResourceTarget): ResourceTargetProfile {
  const profile = PROFILES[target];
  if (!profile) throw new Error(`unknown resource target ${target}`);
  return profile;
}

/**
 * Fail closed before any network use: the app segment a run was configured
 * with must be the one the profile's capability scope covers, otherwise a
 * scoped session would be requested for a path the run never writes.
 */
export function assertProfileCoversApp(profile: ResourceTargetProfile, app: string): void {
  if (profile.tagCapabilityScope !== tagScope(app)) {
    throw new Error(`resource run refused: app '${app}' is outside the pinned capability scope for ${profile.target}`);
  }
}
