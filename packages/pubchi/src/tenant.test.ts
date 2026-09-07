import { describe, expect, it } from "vitest";
import { delegationUri, ownerBindingUri, signDeviceDelegationV1 } from "@pubky/pubchi-schemas";
import { createTenantResolver } from "./tenant.js";
import {
  loadFixture,
  TEST_BOT,
  TEST_FAKE,
  TEST_FAKE_SEED,
  TEST_NOW,
  TEST_OWNER,
  testTenant,
} from "./test-helpers.js";
import type { PublicHomeserverReader } from "./homeserver-read.js";

function readerOf(impl: (uri: string) => Promise<{ status: number; body: unknown }>): PublicHomeserverReader {
  return { getJson: impl };
}

describe("tenant resolution", () => {
  it("enrolled TenantV1 at the U→B binding path", async () => {
    const tenant = testTenant();
    const resolver = createTenantResolver(
      readerOf(async (uri) => {
        expect(uri).toBe(ownerBindingUri(TEST_OWNER, TEST_BOT));
        return { status: 200, body: tenant };
      }),
    );
    const out = await resolver.resolve(TEST_OWNER, TEST_BOT);
    expect(out).toEqual({ ok: true, tenant });
  });

  it("enrolled OwnerBindingV1 becomes a Phase 0 TenantV1", async () => {
    const binding = loadFixture("valid/owner-binding__active.json");
    const resolver = createTenantResolver(readerOf(async () => ({ status: 200, body: binding })));
    const out = await resolver.resolve(TEST_OWNER, TEST_BOT);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.tenant.owner).toBe(TEST_OWNER);
      expect(out.tenant.bot).toBe(TEST_BOT);
      expect(out.tenant.tier).toBe("read-only");
    }
  });

  it("not enrolled → TENANT_NOT_ENROLLED", async () => {
    const resolver = createTenantResolver(readerOf(async () => ({ status: 404, body: null })));
    const out = await resolver.resolve(TEST_OWNER, TEST_BOT);
    expect(out).toEqual({ ok: false, code: "TENANT_NOT_ENROLLED" });
  });

  it("wrong tier → TIER_UNSUPPORTED", async () => {
    const assisted = loadFixture("invalid/tenant__TIER_UNSUPPORTED__assisted.json");
    const resolver = createTenantResolver(readerOf(async () => ({ status: 200, body: assisted })));
    const out = await resolver.resolve(TEST_OWNER, TEST_BOT);
    expect(out).toEqual({ ok: false, code: "TIER_UNSUPPORTED" });
  });

  it("malformed binding → SCHEMA_INVALID", async () => {
    const resolver = createTenantResolver(readerOf(async () => ({ status: 200, body: { not: "a tenant" } })));
    const out = await resolver.resolve(TEST_OWNER, TEST_BOT);
    expect(out).toEqual({ ok: false, code: "SCHEMA_INVALID" });
  });

  it("negative-caches UPSTREAM_UNAVAILABLE for 30s per (asker, bot)", async () => {
    let hits = 0;
    let now = 1_000;
    const resolver = createTenantResolver(
      readerOf(async () => {
        hits += 1;
        throw new Error("homeserver down");
      }),
      { now: () => now },
    );
    const first = await resolver.resolve(TEST_OWNER, TEST_BOT);
    expect(first).toMatchObject({ ok: false, code: "UPSTREAM_UNAVAILABLE" });
    now = 20_000;
    const second = await resolver.resolve(TEST_OWNER, TEST_BOT);
    expect(second).toMatchObject({ ok: false, code: "UPSTREAM_UNAVAILABLE" });
    expect(hits).toBe(1);
    now = 40_000;
    await resolver.resolve(TEST_OWNER, TEST_BOT);
    expect(hits).toBe(2);
  });

  it("caches a successful enrollment for 60s", async () => {
    let hits = 0;
    let now = 1_000;
    const resolver = createTenantResolver(
      readerOf(async () => {
        hits += 1;
        return { status: 200, body: testTenant() };
      }),
      { cacheMs: 60_000, now: () => now },
    );
    await resolver.resolve(TEST_OWNER, TEST_BOT);
    now = 30_000;
    await resolver.resolve(TEST_OWNER, TEST_BOT);
    expect(hits).toBe(1);
    now = 70_000;
    await resolver.resolve(TEST_OWNER, TEST_BOT);
    expect(hits).toBe(2);
  });

  it("verifies a device delegation at the exact owner/device path", async () => {
    const delegation = signDeviceDelegationV1(
      {
        schema: "pubchi-device-delegation",
        version: 1,
        owner: TEST_OWNER,
        signer: TEST_FAKE,
        bot: TEST_BOT,
        purposes: ["who-tagged-me"],
        created_at: TEST_NOW - 1,
        expires_at: TEST_NOW + 100,
      },
      TEST_FAKE_SEED,
    );
    const resolver = createTenantResolver(
      readerOf(async (uri) => {
        expect(uri).toBe(delegationUri(TEST_OWNER, TEST_FAKE));
        return { status: 200, body: delegation };
      }),
    );
    await expect(resolver.resolveDelegation(TEST_OWNER, TEST_FAKE, TEST_BOT, "who-tagged-me", TEST_NOW)).resolves.toEqual({
      ok: true,
      delegation,
    });
  });

  it("caches delegation 404s for 60s (negative caching keeps repeats free)", async () => {
    let hits = 0;
    let now = 1_000;
    const resolver = createTenantResolver(
      readerOf(async () => {
        hits += 1;
        return { status: 404, body: null };
      }),
      { now: () => now },
    );
    await resolver.resolveDelegation(TEST_OWNER, TEST_FAKE, TEST_BOT, "who-tagged-me", TEST_NOW);
    now = 30_000;
    await resolver.resolveDelegation(TEST_OWNER, TEST_FAKE, TEST_BOT, "who-tagged-me", TEST_NOW);
    expect(hits).toBe(1);
    now = 70_000;
    await resolver.resolveDelegation(TEST_OWNER, TEST_FAKE, TEST_BOT, "who-tagged-me", TEST_NOW);
    expect(hits).toBe(2);
  });

  it("caches a verified delegation for only 15s (revocation bound)", async () => {
    const delegation = signDeviceDelegationV1(
      {
        schema: "pubchi-device-delegation",
        version: 1,
        owner: TEST_OWNER,
        signer: TEST_FAKE,
        bot: TEST_BOT,
        purposes: ["who-tagged-me"],
        created_at: TEST_NOW - 1,
        expires_at: TEST_NOW + 3_600,
      },
      TEST_FAKE_SEED,
    );
    let hits = 0;
    let now = 1_000;
    const resolver = createTenantResolver(
      readerOf(async () => {
        hits += 1;
        return { status: 200, body: delegation };
      }),
      { now: () => now },
    );
    await resolver.resolveDelegation(TEST_OWNER, TEST_FAKE, TEST_BOT, "who-tagged-me", TEST_NOW);
    now = 10_000;
    await resolver.resolveDelegation(TEST_OWNER, TEST_FAKE, TEST_BOT, "who-tagged-me", TEST_NOW);
    expect(hits).toBe(1);
    now = 20_000;
    await resolver.resolveDelegation(TEST_OWNER, TEST_FAKE, TEST_BOT, "who-tagged-me", TEST_NOW);
    expect(hits).toBe(2);
  });

  it("pins the delegation cache to its cap under more inserts than the cap", async () => {
    // Must match DELEGATION_CACHE_MAX_ENTRIES in tenant.ts.
    const cap = 1024;
    let hits = 0;
    const resolver = createTenantResolver(
      readerOf(async () => {
        hits += 1;
        return { status: 404, body: null };
      }),
      // The per-victim fetch limiter is disabled here so the cap itself is observed.
      { now: () => 1_000, fetchLimiter: { take: () => true } },
    );
    const signer = (i: number) => `signer-${i}`;
    for (let i = 0; i < cap + 10; i += 1) {
      await resolver.resolveDelegation(TEST_OWNER, signer(i), TEST_BOT, "who-tagged-me", TEST_NOW);
    }
    expect(hits).toBe(cap + 10);
    // The oldest entries were evicted: re-resolving signer 0 fetches again...
    await resolver.resolveDelegation(TEST_OWNER, signer(0), TEST_BOT, "who-tagged-me", TEST_NOW);
    expect(hits).toBe(cap + 11);
    // ...while the most recent entries are still cached.
    await resolver.resolveDelegation(TEST_OWNER, signer(cap + 9), TEST_BOT, "who-tagged-me", TEST_NOW);
    expect(hits).toBe(cap + 11);
  });

  it("bounds outbound homeserver fetches per victim asker, cache hits stay free", async () => {
    let hits = 0;
    let now = 1_000;
    const resolver = createTenantResolver(
      readerOf(async () => {
        hits += 1;
        return { status: 404, body: null };
      }),
      { now: () => now },
    );
    // Distinct (asker, bot) pairs for one victim asker: each is a cache miss,
    // but the per-victim fetch bucket caps outbound work at the burst of 4.
    for (let i = 0; i < 10; i += 1) {
      const out = await resolver.resolve(TEST_OWNER, `bot-${i}`);
      if (i < 4) expect(out).toEqual({ ok: false, code: "TENANT_NOT_ENROLLED" });
      else expect(out).toMatchObject({ ok: false, code: "UPSTREAM_UNAVAILABLE", cause: "asker_fetch_limited" });
    }
    expect(hits).toBe(4);
    // Cached negatives are free and do not consume the bucket.
    const cached = await resolver.resolve(TEST_OWNER, "bot-0");
    expect(cached).toEqual({ ok: false, code: "TENANT_NOT_ENROLLED" });
    expect(hits).toBe(4);
    // Refill is 2 fetches per 60s per victim: one more fetch after 30s.
    now = 31_000;
    await resolver.resolve(TEST_OWNER, "bot-10");
    expect(hits).toBe(5);
    await resolver.resolve(TEST_OWNER, "bot-11");
    expect(hits).toBe(5);
    // Delegation fetches share the same per-victim bucket: 30s later one token
    // has refilled, so exactly one delegation fetch is allowed through.
    now = 61_000;
    const delegated = await resolver.resolveDelegation(TEST_OWNER, TEST_FAKE, TEST_BOT, "who-tagged-me", TEST_NOW);
    expect(delegated).toEqual({ ok: false, code: "DELEGATION_NOT_FOUND" });
    expect(hits).toBe(6);
    const blocked = await resolver.resolveDelegation(TEST_OWNER, "signer-other", TEST_BOT, "who-tagged-me", TEST_NOW);
    expect(blocked).toMatchObject({ ok: false, code: "UPSTREAM_UNAVAILABLE", cause: "asker_fetch_limited" });
    expect(hits).toBe(6);
  });
});
