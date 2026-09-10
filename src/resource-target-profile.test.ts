import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@synonymdev/pubky";
import { describe, expect, it } from "vitest";
import { RESOURCE_PILOT_BOT_PK, STAGING_HOMESERVER_HOST, STAGING_HOMESERVER_PK } from "./outbound-gate.js";
import { DEFAULT_RESOURCE_APP } from "./resource-publish.js";
import {
  PRODUCTION_HOMESERVER_HOST,
  PRODUCTION_HOMESERVER_PK,
  PRODUCTION_RESOURCE_CONFIG_VERSION,
  PRODUCTION_RESOURCE_PROFILE,
  PUBKYAUTH_RELAY_URL,
  RESOURCE_PIN_SET_VERSION,
  STAGING_RESOURCE_PROFILE,
  assertProfileCoversApp,
  resourceTargetProfile,
} from "./resource-target-profile.js";
import { RESOURCE_CONFIG_VERSION } from "./resource-taxonomy.js";
import { JEB_PUBKY } from "./weekly/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const FIXTURE = join(here, "test-fixtures/production-homeserver-pkdns.json");

type PkdnsFixture = {
  identity: { publicKey: string };
  resolvedHomeserver: { publicKey: string; host: string };
};

async function pkdnsFixture(): Promise<PkdnsFixture> {
  return JSON.parse(await readFile(FIXTURE, "utf8")) as PkdnsFixture;
}

describe("production homeserver pin provenance", () => {
  it("resolves the compiled pin from the checked-in PKDNS fixture", async () => {
    const fixture = await pkdnsFixture();
    expect(fixture.identity.publicKey).toBe(JEB_PUBKY);
    expect(fixture.resolvedHomeserver.publicKey).toBe(PRODUCTION_HOMESERVER_PK);
    expect(fixture.resolvedHomeserver.host).toBe(PRODUCTION_HOMESERVER_HOST);
  });

  it("parses as a real 32-byte public key through the SDK's own decoder", async () => {
    const fixture = await pkdnsFixture();
    const parsed = PublicKey.from(fixture.resolvedHomeserver.publicKey);
    expect(parsed.z32()).toBe(PRODUCTION_HOMESERVER_PK);
    expect(PublicKey.from(PRODUCTION_HOMESERVER_PK).z32()).toBe(fixture.resolvedHomeserver.publicKey);
  });

  // Deliberate negative: a pin that drifts from the resolution must not decode
  // to the same identity, so the equality above has real teeth. The tampered
  // character is deliberately the first one: a 52-character z-base32 string
  // carries 260 bits for a 256-bit key, so several final characters decode to
  // the same 32 bytes and a last-character edit would prove nothing.
  it("rejects a pin that differs from the fixture in a significant character", async () => {
    const fixture = await pkdnsFixture();
    const original = fixture.resolvedHomeserver.publicKey;
    const tampered = `${original[0] === "8" ? "9" : "8"}${original.slice(1)}`;
    expect(tampered).not.toBe(PRODUCTION_HOMESERVER_PK);
    expect(PublicKey.from(tampered).z32()).not.toBe(PRODUCTION_HOMESERVER_PK);
  });

  it("keeps the production pin distinct from staging and from the publisher", () => {
    expect(PRODUCTION_HOMESERVER_PK).not.toBe(STAGING_HOMESERVER_PK);
    expect(PRODUCTION_HOMESERVER_PK).not.toBe(JEB_PUBKY);
    expect(PRODUCTION_HOMESERVER_HOST).not.toBe(STAGING_HOMESERVER_HOST);
  });
});

describe("pinned pubkyauth relay", () => {
  it("is byte-identical to the default compiled into the installed SDK", async () => {
    const wasm = await readFile(join(repoRoot, "node_modules/@synonymdev/pubky/pubky_bg.wasm"));
    expect(wasm.includes(Buffer.from(PUBKYAUTH_RELAY_URL, "utf8"))).toBe(true);
    // Exactly one relay host literal, so the pin is the default rather than
    // one of several candidates.
    let occurrences = 0;
    for (let at = 0; (at = wasm.indexOf(Buffer.from("httprelay.pubky.app", "utf8"), at)) !== -1; at += 1) {
      occurrences += 1;
    }
    expect(occurrences).toBe(1);
    // Not a truncation of a longer default path: the design's own history has
    // a case where every document said `/link/` and production used a
    // different path, so the pin is checked against the artifact, not a doc.
    expect(wasm.includes(Buffer.from(`${PUBKYAUTH_RELAY_URL}/`, "utf8"))).toBe(false);
  });

  // Deliberate negative: an invented relay is not the SDK default.
  it("does not match a relay this repo made up", async () => {
    const wasm = await readFile(join(repoRoot, "node_modules/@synonymdev/pubky/pubky_bg.wasm"));
    expect(wasm.includes(Buffer.from("https://relay.jeb.example/link", "utf8"))).toBe(false);
  });

  it("is an https URL and identical on both profiles", () => {
    expect(new URL(PUBKYAUTH_RELAY_URL).protocol).toBe("https:");
    expect(STAGING_RESOURCE_PROFILE.authRelayUrl).toBe(PUBKYAUTH_RELAY_URL);
    expect(PRODUCTION_RESOURCE_PROFILE.authRelayUrl).toBe(PUBKYAUTH_RELAY_URL);
  });
});

describe("pinned target profiles", () => {
  it("selects staging pins that match the existing outbound-gate constants", () => {
    const profile = resourceTargetProfile("staging");
    expect(profile).toBe(STAGING_RESOURCE_PROFILE);
    expect(profile.nexusUrl).toBe("https://nexus.staging.pubky.app");
    expect(profile.homeserverPk).toBe(STAGING_HOMESERVER_PK);
    expect(profile.homeserverHost).toBe(STAGING_HOMESERVER_HOST);
    expect(profile.publisherPk).toBe(RESOURCE_PILOT_BOT_PK);
    expect(profile.signedConfigVersion).toBe(RESOURCE_CONFIG_VERSION);
  });

  it("selects production pins for Jeb's real identity", () => {
    const profile = resourceTargetProfile("production");
    expect(profile.nexusUrl).toBe("https://nexus.pubky.app");
    expect(profile.homeserverPk).toBe(PRODUCTION_HOMESERVER_PK);
    expect(profile.homeserverHost).toBe(PRODUCTION_HOMESERVER_HOST);
    expect(profile.publisherPk).toBe(JEB_PUBKY);
    expect(profile.signedConfigVersion).toBe(PRODUCTION_RESOURCE_CONFIG_VERSION);
  });

  it("keeps every cross-target pin distinct so a mismatch cannot pass", () => {
    const staging = resourceTargetProfile("staging");
    const production = resourceTargetProfile("production");
    expect(staging.nexusUrl).not.toBe(production.nexusUrl);
    expect(staging.homeserverPk).not.toBe(production.homeserverPk);
    expect(staging.publisherPk).not.toBe(production.publisherPk);
    expect(staging.signedConfigVersion).not.toBe(production.signedConfigVersion);
  });

  it("carries no target-independent state that a caller can mutate", () => {
    expect(Object.isFrozen(STAGING_RESOURCE_PROFILE)).toBe(true);
    expect(Object.isFrozen(PRODUCTION_RESOURCE_PROFILE)).toBe(true);
  });

  it("shares one pin-set version across profiles for the build stamp", () => {
    expect(STAGING_RESOURCE_PROFILE.pinSetVersion).toBe(RESOURCE_PIN_SET_VERSION);
    expect(PRODUCTION_RESOURCE_PROFILE.pinSetVersion).toBe(RESOURCE_PIN_SET_VERSION);
  });

  // Deliberate negative: an unknown target never yields a usable profile.
  it("refuses an unknown target", () => {
    expect(() => resourceTargetProfile("mainnet" as never)).toThrow(/unknown resource target/);
  });

  it("confines the capability scope to Jeb's own tag subtree", () => {
    for (const profile of [STAGING_RESOURCE_PROFILE, PRODUCTION_RESOURCE_PROFILE]) {
      expect(profile.tagCapabilityScope).toBe(`/pub/${DEFAULT_RESOURCE_APP}/tags/`);
      expect(profile.tagCapabilityScope.startsWith("/pub/pubky.app/")).toBe(false);
    }
  });

  it("accepts the configured app when it matches the pinned scope", () => {
    expect(() => assertProfileCoversApp(PRODUCTION_RESOURCE_PROFILE, DEFAULT_RESOURCE_APP)).not.toThrow();
  });

  // Deliberate negative: a different app segment would need a different scope.
  it("refuses an app segment outside the pinned capability scope", () => {
    expect(() => assertProfileCoversApp(PRODUCTION_RESOURCE_PROFILE, "eventky.app")).toThrow(
      /outside the pinned capability scope/,
    );
    expect(() => assertProfileCoversApp(STAGING_RESOURCE_PROFILE, "pubky.app")).toThrow(
      /outside the pinned capability scope/,
    );
  });
});
