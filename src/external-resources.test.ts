import { describe, expect, it } from "vitest";
import {
  assertResourceRunConfig,
  discoverResources,
  IdempotentResourcePublisher,
  normalizeUri,
  resourceIdentity,
  validateResourceLimit,
  type ExternalResource,
  type ExternalResourceInput,
} from "./external-resources.js";
import { PRODUCTION_HOMESERVER_PK, STAGING_HOMESERVER_PK } from "./outbound-gate.js";

const base = {
  family: "url" as const,
  category: "pubky" as const,
  source: "staging-catalog",
  sourcePriority: 10,
  labels: ["release"],
};

describe("external resource seeding", () => {
  it.each([
    ["HTTPS://Example.COM:443/path?q=1#frag", "https://example.com/path?q=1"],
    ["https://example.com", "https://example.com/"],
    ["http://example.com:8080/path", "http://example.com:8080/path"],
    ["HTTPS://Example.COM/path?b=2&a=1", "https://example.com/path?b=2&a=1"],
    ["https://user:pass@example.com/path", "https://example.com/path"],
    ["HTTP://Example.COM:80/", "http://example.com/"],
    ["nostr:note1abc123...", "nostr:note1abc123..."],
    [
      "pubky://8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo/pub/eventky.app/events/E001",
      "pubky://8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo/pub/eventky.app/events/E001",
    ],
  ])("matches the upstream normalize_uri vector for %s", (input, expected) => {
    expect(normalizeUri(input)).toBe(expected);
  });

  it.each([
    "ht tps://example.com",
    "justtext",
    "1ttp://example.com",
    "+nostr:note1abc",
    "-nostr:note1abc",
    ".nostr:note1abc",
  ])("rejects the upstream malformed URI vector %s", (input) => {
    expect(() => normalizeUri(input)).toThrow();
  });

  it("matches the Rust BLAKE3 resource id known answer", () => {
    expect(resourceIdentity("https://example.com/path?q=1")).toBe("2397d03755c83364010ee03600730121");
    expect(resourceIdentity(normalizeUri("HTTPS://Example.COM:443/path?q=1#frag"))).toBe("2397d03755c83364010ee03600730121");
  });

  it("accepts URL resources and produces compact provenance", () => {
    const run = discoverResources(
      [{ ...base, value: "https://Docs.Example.test/guide/?utm_source=x&b=2#a" }],
      { limit: 100, configVersion: "test-v1", now: new Date("2026-09-08T10:00:00.000Z") },
    );
    expect(run.accepted[0]).toMatchObject({
      displayValue: "https://docs.example.test/guide/",
      canonicalValue: "https://docs.example.test/guide/?utm_source=x&b=2",
      identity: expect.stringMatching(/^[0-9a-f]{32}$/),
      provenance: { source: "staging-catalog", configVersion: "test-v1", decision: "accepted" },
    });
    expect(run.accepted[0]?.identity).toBe(resourceIdentity("https://docs.example.test/guide/?utm_source=x&b=2"));
    const dotted = discoverResources(
      [{ ...base, value: "https://docs.example.test./guide" }],
      { limit: 100, configVersion: "test-v1" },
    );
    expect(dotted.accepted[0]?.identity).toBe(resourceIdentity("https://docs.example.test./guide"));
    expect(dotted.accepted[0]?.canonicalValue).toBe("https://docs.example.test./guide");
  });

  it("rejects source-default URLs with no publishable labels", () => {
    const run = discoverResources(
      [{ ...base, value: "https://unmatched.example/" , labels: [] }],
      { limit: 100, configVersion: "test-v1" },
    );
    expect(run.accepted).toHaveLength(0);
    expect(run.rejected[0]?.reason).toBe("no publishable labels");
    expect(run.shadowReport.byRejectionReason["no publishable labels"]).toBe(1);
  });

  it("deduplicates URL variants deterministically", () => {
    const run = discoverResources(
      [
        { ...base, value: "https://example.test/guide" },
        { ...base, sourcePriority: 1, value: "https://EXAMPLE.test:443/guide#overview" },
      ],
      { limit: 100, configVersion: "test-v1" },
    );
    expect(run.accepted).toHaveLength(1);
    expect(run.rejected[0]?.reason).toBe("duplicate canonical identity");
  });

  it("deduplicates exact normalized URI variants deterministically", () => {
    const run = discoverResources(
      [
        { ...base, value: "https://example.test/guide/" },
        { ...base, sourcePriority: 1, value: "https://EXAMPLE.test:443/guide#overview" },
      ],
      { limit: 100, configVersion: "test-v1" },
    );
    expect(run.accepted).toHaveLength(2);
  });

  it("rejects duplicate normalized identities", () => {
    const run = discoverResources(
      [
        { ...base, value: "https://example.test/docs?b=2&a=1" },
        { ...base, sourcePriority: 1, value: "HTTPS://EXAMPLE.TEST/docs?b=2&a=1#fragment" },
      ],
      { limit: 100, configVersion: "test-v2" },
    );
    expect(run.accepted).toHaveLength(1);
    expect(run.rejected[0]?.reason).toBe("duplicate canonical identity");
  });

  it("rejects unsafe, production, and invalid taxonomy inputs", () => {
    const run = discoverResources(
      [
        { ...base, value: "javascript:alert(1)" },
        { ...base, value: "https://pubky.app/docs" },
        { ...base, value: "https://example.test/docs", labels: ["bitcoin"] },
      ],
      { limit: 100, configVersion: "test-v1" },
    );
    expect(run.accepted).toHaveLength(0);
    expect(run.rejected.map((item) => item.reason)).toEqual(expect.arrayContaining([
      "unsafe URL protocol",
      "production target is not allowed",
      "invalid URL taxonomy label",
    ]));
    expect(run.rejected).toHaveLength(3);
  });

  it("accepts homepage URLs including slash and slashless forms with one identity", () => {
    expect(normalizeUri("https://bitcoin.org/")).toBe("https://bitcoin.org/");
    expect(normalizeUri("https://bitcoin.org")).toBe("https://bitcoin.org/");
    const slash = discoverResources([{ ...base, value: "https://bitcoin.org/" }], { limit: 100, configVersion: "test-v1" });
    const noslash = discoverResources([{ ...base, value: "https://bitcoin.org" }], { limit: 100, configVersion: "test-v1" });
    expect(slash.accepted).toHaveLength(1);
    expect(noslash.accepted).toHaveLength(1);
    expect(slash.accepted[0]?.identity).toBe(noslash.accepted[0]?.identity);
    expect(slash.accepted[0]?.identity).toBe(resourceIdentity("https://bitcoin.org/"));
    const run = discoverResources(
      [
        { ...base, value: "https://example.test/" },
        { ...base, value: "https://bitcoin.org/" },
        { ...base, value: "https://bitcoin.org" },
        { ...base, value: "https://pubky.org/" },
      ],
      { limit: 100, configVersion: "test-v1" },
    );
    expect(run.accepted).toHaveLength(3);
    expect(run.rejected).toHaveLength(1);
    expect(run.rejected[0]?.reason).toBe("duplicate canonical identity");
    expect(run.accepted.map((item) => item.canonicalValue).sort()).toEqual([
      "https://bitcoin.org/",
      "https://example.test/",
      "https://pubky.org/",
    ]);
  });

  it("normalizes before host checks and blocks production suffixes", () => {
    const run = discoverResources(
      [
        { ...base, value: "https://example.test:443/#overview" },
        { ...base, value: "https://PUBKY.APP./docs?token=secret" },
        { ...base, value: "https://sub.nexus.pubky.app./docs" },
      ],
      { limit: 100, configVersion: "test-v1" },
    );
    expect(run.accepted).toHaveLength(1);
    expect(run.accepted[0]?.canonicalValue).toBe("https://example.test/");
    expect(run.rejected.map((item) => item.reason)).toEqual(
      expect.arrayContaining(["URL credentials are not allowed", "production target is not allowed"]),
    );
    expect(JSON.stringify(run)).not.toContain("secret");
  });

  it("rejects malformed records without aborting the batch", () => {
    const run = discoverResources(
      [null as unknown as ExternalResourceInput, { ...base, value: 42 } as unknown as ExternalResourceInput, { ...base, value: "https://example.test/docs" }],
      { limit: 100, configVersion: "test-v1" },
    );
    expect(run.rejected[0]?.reason).toBe("invalid resource record");
    expect(run.rejected[1]?.reason).toBe("invalid resource record");
    expect(run.accepted).toHaveLength(1);
  });

  it("rejects non-URL families in the first slice", () => {
    const run = discoverResources(
      [{ ...base, family: "geocoordinate", value: "51.5,-0.1" }],
      { limit: 100, configVersion: "test-v1" },
    );
    expect(run.rejected[0]?.reason).toBe("resource family is not enabled in the staging URL slice");
  });

  it("canonicalizes enabled families and composes music taxonomies", () => {
    const run = discoverResources(
      [
        { ...base, source: "geonames", family: "geocoordinate", value: "51.5000, -0.1000" },
        { ...base, source: "staging-catalog", family: "stable-identifier", value: "doi:10.1000/ABC" },
        { ...base, value: "https://open.spotify.com/track/abc123" },
      ],
      { limit: 100, configVersion: "test-v2" },
    );
    expect(run.accepted.map((resource) => resource.canonicalValue)).toEqual([
      "geo:51.5,-0.1",
      "doi:10.1000/abc",
      "https://open.spotify.com/track/abc123",
    ]);
    expect(run.accepted.find((resource) => resource.canonicalValue.includes("spotify"))?.labels).toEqual([
      "music",
      "music-track",
      "release",
    ]);
  });

  it("rejects a music type on a non-music object", () => {
    const run = discoverResources(
      [{ ...base, value: "https://example.test/track/abc", taxonomy: { type: ["track"] } }],
      { limit: 100, configVersion: "test-v2" },
    );
    expect(run.rejected[0]?.reason).toBe("music type requires music domain");
  });

  it("supports aggregate reporting and operator family disabling", () => {
    const run = discoverResources(
      [{ ...base, value: "https://example.test/docs", taxonomy: { type: ["document"] } }],
      { limit: 100, configVersion: "test-v2", disabledFamilies: ["url"] },
    );
    expect(run.accepted).toHaveLength(0);
    expect(run.shadowReport.byRejectionReason["resource family disabled"]).toBe(1);
  });

  it("rejects a limit above the hard maximum", () => {
    expect(() => validateResourceLimit(101)).toThrow("1 to 100");
    expect(() =>
      discoverResources([], { limit: 101, configVersion: "test-v1" }),
    ).toThrow("1 to 100");
  });

  it("rejects an input batch above 100 before processing any records", () => {
    const source = Array.from({ length: 101 }, (_, index) => ({
      ...base,
      value: `https://example.test/docs/${index}`,
    }));
    const accesses: string[] = [];
    const inputs = new Proxy(source, {
      get(target, property, receiver) {
        accesses.push(String(property));
        return Reflect.get(target, property, receiver);
      },
    });

    expect(() => discoverResources(inputs, { limit: 100, configVersion: "test-v1" })).toThrow(
      "resource input batch must contain no more than 100 records",
    );
    expect(accesses).toEqual(["length"]);
  });

  it("rejects inputs without labels at runtime", () => {
    const input = { ...base, labels: undefined } as unknown as Parameters<typeof discoverResources>[0][number];

    const run = discoverResources([input], { limit: 100, configVersion: "test-v1" });

    expect(run.rejected[0]?.reason).toBe("invalid resource record");
  });

  it("rejects staging.pubky.app hosts as production targets", () => {
    const run = discoverResources(
      [{ ...base, value: "https://nexus.staging.pubky.app/docs" }],
      { limit: 100, configVersion: "test-v1" },
    );
    expect(run.rejected[0]?.reason).toBe("production target is not allowed");
  });

  it("keeps query pairs in normalized identity while redacting operator output", () => {
    const run = discoverResources(
      [
        { ...base, value: "https://example.test/docs?ref=a" },
        { ...base, value: "https://example.test/docs?ref=b" },
      ],
      { limit: 100, configVersion: "test-v1" },
    );
    expect(run.accepted.map((item) => item.displayValue)).toEqual([
      "https://example.test/docs",
      "https://example.test/docs",
    ]);
    expect(run.accepted.map((item) => item.canonicalValue).sort()).toEqual([
      "https://example.test/docs?ref=a",
      "https://example.test/docs?ref=b",
    ]);
    expect(run.accepted.map((item) => item.identity).sort()).toEqual([
      resourceIdentity("https://example.test/docs?ref=a"),
      resourceIdentity("https://example.test/docs?ref=b"),
    ].sort());
    expect(new Set(run.accepted.map((item) => item.identity)).size).toBe(2);
  });

  it("preserves query order, tracking parameters, and trailing path slashes in identity", () => {
    const values = [
      "https://example.test/docs?b=2&a=1",
      "https://example.test/docs?a=1&b=2",
      "https://example.test/docs?utm_source=x",
      "https://example.test/docs/?utm_source=x",
    ];
    const run = discoverResources(
      values.map((value) => ({ ...base, value })),
      { limit: 100, configVersion: "test-v1" },
    );
    expect(run.accepted).toHaveLength(4);
    expect(new Set(run.accepted.map((item) => item.identity)).size).toBe(4);
    expect(run.accepted.every((item) => !item.displayValue.includes("?"))).toBe(true);
  });

  it("rejects credentialed URLs and credential-like query keys without echoing secrets", () => {
    const run = discoverResources(
      [
        { ...base, value: "https://user:pass@example.test/docs" },
        { ...base, value: "https://example.test/docs?token=super-secret&ref=1" },
        { ...base, value: "https://example.test/docs?sig=hmac-secret-value" },
        { ...base, value: "https://example.test/docs?auth_token=auth-secret-value" },
        { ...base, value: "https://example.test/docs?access-key=ak-secret-value" },
        { ...base, value: "https://example.test/docs?private_key=pk-secret-value" },
        { ...base, value: "https://example.test/docs?passwd=pw-secret-value" },
        { ...base, value: "https://example.test/docs?credential=cred-secret-value" },
        { ...base, value: "https://example.test/docs?bearer=br-secret-value" },
      ],
      { limit: 100, configVersion: "test-v1" },
    );
    expect(run.accepted).toHaveLength(0);
    expect(run.rejected.map((item) => item.reason)).toEqual(Array(9).fill("URL credentials are not allowed"));
    const dumped = JSON.stringify(run);
    expect(dumped).not.toContain("pass");
    expect(dumped).not.toContain("super-secret");
    expect(dumped).not.toContain("hmac-secret-value");
    expect(dumped).not.toContain("auth-secret-value");
    expect(dumped).not.toContain("ak-secret-value");
    expect(dumped).not.toContain("pk-secret-value");
    expect(dumped).not.toContain("pw-secret-value");
    expect(dumped).not.toContain("cred-secret-value");
    expect(dumped).not.toContain("br-secret-value");
    expect(run.rejected[0]?.input.value).toBe("https://example.test/docs");
  });

  it("rejects loopback and private catalog hosts", () => {
    const run = discoverResources(
      [
        { ...base, value: "http://127.0.0.1/docs" },
        { ...base, value: "https://localhost/docs" },
        { ...base, value: "https://192.168.1.8/docs" },
        { ...base, value: "https://[::1]/docs" },
        { ...base, value: "https://[fd00::abcd]/docs" },
      ],
      { limit: 100, configVersion: "test-v1" },
    );
    expect(run.accepted).toHaveLength(0);
    expect(run.rejected.map((item) => item.reason)).toEqual([
      "unsafe URL protocol",
      "private or loopback host is not allowed",
      "private or loopback host is not allowed",
      "private or loopback host is not allowed",
      "private or loopback host is not allowed",
    ]);
  });

  it("classifies bracketed IPv6 loopback and unique-local hosts as private", () => {
    const run = discoverResources(
      [
        { ...base, value: "https://[::1]/docs" },
        { ...base, value: "https://[FD00::1]/guide" },
      ],
      { limit: 100, configVersion: "test-v1" },
    );
    expect(run.accepted).toHaveLength(0);
    expect(run.rejected.map((item) => item.reason)).toEqual([
      "private or loopback host is not allowed",
      "private or loopback host is not allowed",
    ]);
  });

  it("rejects an input category that conflicts with the run category", () => {
    const run = discoverResources(
      [{ ...base, category: "other" as ExternalResourceInput["category"], value: "https://example.test/docs" }],
      { limit: 100, configVersion: "test-v1" },
    );
    expect(run.rejected[0]?.reason).toBe("category conflict");
  });

  it("rejects https stable-identifiers that fail the URL gates", () => {
    const run = discoverResources(
      [
        {
          family: "stable-identifier",
          value: "https://127.0.0.1/x?token=abc",
          source: "staging-catalog",
          labels: ["documentation"],
        },
      ],
      { limit: 100, configVersion: "test-v1" },
    );
    expect(run.accepted).toHaveLength(0);
    expect(run.rejected[0]?.reason).toBe("URL credentials are not allowed");
  });

  // The homeserver pin is the compiled target profile, never JEB_HOMESERVER:
  // this check validates mode and limit only, so the executor env contract
  // (which forbids JEB_HOMESERVER by name) cannot deadlock against it.
  it("checks mode and limit only, with no homeserver requirement", () => {
    for (const resourceMode of ["publish", "reconcile"] as const) {
      expect(() => assertResourceRunConfig({ resourceTarget: "production", resourceMode, resourceMaxRecords: 100 })).not.toThrow();
      expect(() => assertResourceRunConfig({ resourceTarget: "staging", resourceMode, resourceMaxRecords: 100 })).not.toThrow();
    }
    expect(() =>
      assertResourceRunConfig({ resourceTarget: "staging", resourceMode: "publish", resourceMaxRecords: 100 }),
    ).not.toThrow();
  });

  it("fails closed for a configured maximum above 100", () => {
    expect(() =>
      assertResourceRunConfig({ resourceTarget: "staging", resourceMode: "shadow", resourceMaxRecords: 101 }),
    ).toThrow("1 to 100");
  });

  it("publishes each identity at most once", async () => {
    const calls: string[] = [];
    const delegate = {
      publish: async (resource: ExternalResource) => {
        calls.push(resource.identity);
        return { identity: resource.identity, published: true };
      },
    };
    const publisher = new IdempotentResourcePublisher(delegate);
    const resource = discoverResources(
      [{ ...base, value: "https://example.test/docs" }],
      { limit: 100, configVersion: "test-v1" },
    ).accepted[0]!;
    await publisher.publish(resource);
    const second = await publisher.publish(resource);
    expect(calls).toHaveLength(1);
    expect(second.published).toBe(false);
  });

  it("reserves an in-flight identity across concurrent calls", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const publisher = new IdempotentResourcePublisher({
      publish: async (resource) => {
        calls += 1;
        await gate;
        return { identity: resource.identity, published: true };
      },
    });
    const resource = discoverResources([{ ...base, value: "https://example.test/concurrent" }], {
      limit: 100,
      configVersion: "test-v1",
    }).accepted[0]!;
    const first = publisher.publish(resource);
    const second = publisher.publish(resource);
    await Promise.resolve();
    expect(calls).toBe(1);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { identity: resource.identity, published: true },
      { identity: resource.identity, published: true },
    ]);
  });
});
