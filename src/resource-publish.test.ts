import { PubkyAppTag } from "pubky-app-specs";
import { describe, expect, it } from "vitest";
import { discoverResources, type ExternalResource } from "./external-resources.js";
import type { Transport } from "./homeserver.js";
import {
  DEFAULT_RESOURCE_APP,
  RESOURCE_WRITE_MAX,
  assertResourceAppName,
  buildUniversalResourceTag,
  gatedResourceTransport,
  isUniversalTagHomeserverPath,
  publishResourceTags,
  resourceTagHomeserverPath,
} from "./resource-publish.js";
import {
  STAGING_HOMESERVER_HOST,
  STAGING_HOMESERVER_PK,
  assertStagingHomeserverPk,
  assertStagingResourceHomeserverHost,
} from "./outbound-gate.js";
import { normalizeUri, resourceIdentity } from "./resource-identity.js";

const BOT = "8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo";

function memoryTransport(
  botPk = BOT,
  resolvedHomeserverPk = STAGING_HOMESERVER_PK,
): Transport & { puts: string[] } {
  const store = new Map<string, unknown>();
  const puts: string[] = [];
  return {
    botPk,
    resolvedHomeserverPk,
    puts,
    async putJson(path, json) {
      puts.push(path);
      store.set(path, json);
    },
    async putBytes() {},
    async getJson(path) {
      if (!store.has(path)) throw new Error("404 Not Found");
      return store.get(path);
    },
    async deleteJson(path) {
      store.delete(path);
    },
    async listPosts() {
      return [];
    },
    async reauth() {},
  };
}

function acceptedOne(): ExternalResource {
  const run = discoverResources(
    [{ family: "url", value: "https://example.test/docs", source: "staging-catalog", labels: ["release"] }],
    { limit: 100, configVersion: "test-v1" },
  );
  return run.accepted[0]!;
}

const stagingCfg = {
  resourceTarget: "staging" as const,
  resourceMode: "publish" as const,
  resourceApp: DEFAULT_RESOURCE_APP,
  resourceConfigVersion: "test-v1",
};

describe("universal tag app name (pubky-app-specs TagPath)", () => {
  it("accepts jeb.pubky.app and eventky.app, rejects pubky.app and slashes", () => {
    expect(assertResourceAppName("jeb.pubky.app")).toBe("jeb.pubky.app");
    expect(assertResourceAppName("eventky.app")).toBe("eventky.app");
    expect(assertResourceAppName("mapky")).toBe("mapky");
    expect(() => assertResourceAppName("pubky.app")).toThrow(/must not be pubky.app/);
    expect(isUniversalTagHomeserverPath("/pub/pubky.app/tags/CBYS8P6VJPHC5XXT4WDW26662W")).toBe(false);
    expect(isUniversalTagHomeserverPath("/pub/jeb.pubky.app/tags/CBYS8P6VJPHC5XXT4WDW26662W")).toBe(true);
    expect(() => assertResourceAppName("my/app")).toThrow(/single path segment/);
  });
});

describe("staging resource publisher contract", () => {
  it("written path matches the specs universal-tag shape and is not under pubky.app", async () => {
    const resource = acceptedOne();
    const client = memoryTransport();
    const manifest = await publishResourceTags([resource], stagingCfg, client);
    expect(manifest.written).toBeGreaterThan(0);
    for (const write of manifest.writes) {
      expect(isUniversalTagHomeserverPath(write.tagPath)).toBe(true);
      expect(write.tagPath.startsWith("/pub/jeb.pubky.app/tags/")).toBe(true);
      expect(write.tagPath.includes("/pub/pubky.app/tags/")).toBe(false);
      // TagPath::parse: pubky://<user>/pub/<app>/tags/<id>, app ≠ pubky.app
      const uri = `pubky://${BOT}${write.tagPath}`;
      expect(uri).toMatch(/^pubky:\/\/[a-z0-9]+\/pub\/jeb\.pubky\.app\/tags\/[A-Z0-9]+$/);
    }
  });

  it("JSON body round-trips through pubky-app-specs PubkyAppTag.fromJson", async () => {
    const resource = acceptedOne();
    const normalized = normalizeUri(resource.canonicalValue);
    const built = buildUniversalResourceTag(BOT, DEFAULT_RESOURCE_APP, normalized, "release");
    const parsed = PubkyAppTag.fromJson(built.body);
    expect(parsed.uri).toBe(normalized);
    expect(parsed.label).toBe("release");
    expect(built.body.uri).toBe(normalized);
    expect(built.path).toBe(resourceTagHomeserverPath(DEFAULT_RESOURCE_APP, built.tagId));
  });

  it("second run of the same batch produces 0 writes", async () => {
    const resource = acceptedOne();
    const client = memoryTransport();
    const first = await publishResourceTags([resource], stagingCfg, client);
    expect(first.written).toBeGreaterThan(0);
    const putsAfterFirst = client.puts.length;
    const second = await publishResourceTags([resource], stagingCfg, client);
    expect(second.written).toBe(0);
    expect(second.skipped_existing).toBe(first.written);
    expect(second.failed).toBe(0);
    expect(client.puts.length).toBe(putsAfterFirst);
  });

  it("production target throws before any client call", async () => {
    const client = memoryTransport();
    await expect(
      publishResourceTags([acceptedOne()], { ...stagingCfg, resourceTarget: "production" }, client),
    ).rejects.toThrow("staging-only");
    expect(client.puts).toEqual([]);
  });

  it("101 inputs are rejected with no writes", async () => {
    const client = memoryTransport();
    expect(() =>
      discoverResources(
        Array.from({ length: 101 }, (_, i) => ({
          family: "url" as const,
          value: `https://example.test/docs/${i}`,
          source: "staging-catalog",
          labels: ["release"],
        })),
        { limit: 100, configVersion: "test-v1" },
      ),
    ).toThrow("no more than 100");
    expect(client.puts).toEqual([]);
  });

  it("records a failed PUT without aborting the batch", async () => {
    const resource = acceptedOne();
    const client = memoryTransport();
    client.putJson = async () => {
      throw new Error("homeserver 500");
    };
    const manifest = await publishResourceTags([resource], stagingCfg, client);
    expect(manifest.failed).toBeGreaterThan(0);
    expect(manifest.written).toBe(0);
  });

  it("resource identity on the write matches normalizeUri + resourceIdentity", async () => {
    const resource = acceptedOne();
    const client = memoryTransport();
    const manifest = await publishResourceTags([resource], stagingCfg, client);
    const write = manifest.writes[0]!;
    expect(write.normalizedUri).toBe(normalizeUri(resource.canonicalValue));
    expect(write.resourceIdentity).toBe(resourceIdentity(write.normalizedUri));
  });
});

describe("resource homeserver egress gate", () => {
  it("allows the staging homeserver host", () => {
    expect(() => assertStagingResourceHomeserverHost(STAGING_HOMESERVER_HOST)).not.toThrow();
    expect(() => assertStagingResourceHomeserverHost("https://homeserver.staging.pubky.app")).not.toThrow();
    expect(() => assertStagingHomeserverPk(STAGING_HOMESERVER_PK)).not.toThrow();
  });

  it("rejects a production homeserver host", () => {
    expect(() => assertStagingResourceHomeserverHost("homeserver.pubky.app")).toThrow(/resource egress refused/);
    expect(() => assertStagingResourceHomeserverHost("https://homeserver.pubky.app")).toThrow(/resource egress refused/);
    expect(() => assertStagingResourceHomeserverHost("nexus.pubky.app")).toThrow(/resource egress refused/);
  });

  it("throws before putJson when resolvedHomeserverPk is missing", async () => {
    const client = memoryTransport();
    client.resolvedHomeserverPk = undefined;
    await expect(publishResourceTags([acceptedOne()], stagingCfg, client)).rejects.toThrow(
      /session homeserver public key is missing/,
    );
    expect(client.puts).toEqual([]);
  });

  it("throws before putJson when the session reports a non-staging homeserver pk", async () => {
    const client = memoryTransport(BOT, "8um71us3aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    await expect(publishResourceTags([acceptedOne()], stagingCfg, client)).rejects.toThrow(
      /homeserver public key is not the staging homeserver/,
    );
    expect(client.puts).toEqual([]);
  });

  it("rejects a production host on the resolved session value", async () => {
    const client = memoryTransport();
    client.resolvedHomeserverHost = "homeserver.pubky.app";
    await expect(publishResourceTags([acceptedOne()], stagingCfg, client)).rejects.toThrow(
      /resource egress refused/,
    );
    expect(client.puts).toEqual([]);
  });

  it("refuses deleteJson on the gated transport", async () => {
    const gated = gatedResourceTransport(memoryTransport());
    await expect(gated.deleteJson("/pub/pubky.app/posts/x")).rejects.toThrow(/does not allow deleteJson/);
  });

  it("rejects a run whose labels would exceed the write cap", async () => {
    const resource = acceptedOne();
    const manyLabels = Array.from({ length: RESOURCE_WRITE_MAX + 1 }, (_, i) => `lab${i}`);
    const bloated = { ...resource, labels: manyLabels };
    const client = memoryTransport();
    await expect(publishResourceTags([bloated], stagingCfg, client)).rejects.toThrow(/max is 300/);
    expect(client.puts).toEqual([]);
  });
});
