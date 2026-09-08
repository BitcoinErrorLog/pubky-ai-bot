import { describe, expect, it } from "vitest";
import {
  assertStagingResourceConfig,
  discoverResources,
  IdempotentResourcePublisher,
  validateResourceLimit,
  type ExternalResource,
  type ExternalResourceInput,
} from "./external-resources.js";

const base = {
  family: "url" as const,
  category: "pubky" as const,
  source: "staging-catalog",
  sourcePriority: 10,
  labels: ["documentation"],
};

describe("external resource seeding", () => {
  it("accepts URL resources and produces compact provenance", () => {
    const run = discoverResources(
      [{ ...base, value: "https://Docs.Example.test/guide/?utm_source=x&b=2#a" }],
      { limit: 100, configVersion: "test-v1", now: new Date("2026-09-08T10:00:00.000Z") },
    );
    expect(run.accepted[0]).toMatchObject({
      canonicalValue: "https://docs.example.test/guide?b=2",
      value: "https://docs.example.test/guide/",
      identity: expect.stringMatching(/^url:[0-9a-f]{64}$/),
      provenance: { source: "staging-catalog", configVersion: "test-v1", decision: "accepted" },
    });
    const dotted = discoverResources(
      [{ ...base, value: "https://docs.example.test./guide" }],
      { limit: 100, configVersion: "test-v1" },
    );
    expect(dotted.accepted[0]?.canonicalValue).toBe("https://docs.example.test/guide");
  });

  it("deduplicates URL variants deterministically", () => {
    const run = discoverResources(
      [
        { ...base, value: "https://example.test/guide/" },
        { ...base, sourcePriority: 1, value: "https://EXAMPLE.test:443/guide#overview" },
      ],
      { limit: 100, configVersion: "test-v1" },
    );
    expect(run.accepted).toHaveLength(1);
    expect(run.rejected[0]?.reason).toBe("duplicate canonical identity");
  });

  it("rejects unsafe, low-value, production, and invalid taxonomy inputs", () => {
    const run = discoverResources(
      [
        { ...base, value: "javascript:alert(1)" },
        { ...base, value: "https://example.test/" },
        { ...base, value: "https://pubky.app/docs" },
        { ...base, value: "https://example.test/docs", labels: ["bitcoin"] },
      ],
      { limit: 100, configVersion: "test-v1" },
    );
    expect(run.accepted).toHaveLength(0);
    expect(run.rejected.map((item) => item.reason)).toEqual(expect.arrayContaining([
      "unsafe URL protocol",
      "low-value URL",
      "production target is not allowed",
      "invalid URL taxonomy label",
    ]));
    expect(run.rejected).toHaveLength(4);
  });

  it("canonicalizes before low-value checks and blocks production suffixes", () => {
    const run = discoverResources(
      [
        { ...base, value: "https://example.test///" },
        { ...base, value: "https://PUBKY.APP./docs?token=secret" },
        { ...base, value: "https://sub.nexus.pubky.app./docs" },
      ],
      { limit: 100, configVersion: "test-v1" },
    );
    expect(run.rejected.map((item) => item.reason)).toEqual(
      expect.arrayContaining(["low-value URL", "production target is not allowed", "production target is not allowed"]),
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

  it("keeps allowed query pairs in identity and displayed canonicalValue", () => {
    const run = discoverResources(
      [
        { ...base, value: "https://example.test/docs?ref=a" },
        { ...base, value: "https://example.test/docs?ref=b" },
      ],
      { limit: 100, configVersion: "test-v1" },
    );
    expect(run.accepted.map((item) => item.canonicalValue).sort()).toEqual([
      "https://example.test/docs?ref=a",
      "https://example.test/docs?ref=b",
    ]);
    expect(new Set(run.accepted.map((item) => item.identity)).size).toBe(2);
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

  it("fails closed for production targets", () => {
    expect(() =>
      assertStagingResourceConfig({ resourceTarget: "production", resourceMode: "shadow", resourceMaxRecords: 100 }),
    ).toThrow("staging-only and shadow-only");
  });

  it("fails closed for publish mode", () => {
    expect(() =>
      assertStagingResourceConfig({ resourceTarget: "staging", resourceMode: "publish", resourceMaxRecords: 100 }),
    ).toThrow("staging-only and shadow-only");
  });

  it("fails closed for a configured maximum above 100", () => {
    expect(() =>
      assertStagingResourceConfig({ resourceTarget: "staging", resourceMode: "shadow", resourceMaxRecords: 101 }),
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
