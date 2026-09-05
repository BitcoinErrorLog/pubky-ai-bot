import { describe, expect, it } from "vitest";
import { ownerBindingUri } from "@pubky/pubchi-schemas";
import { createTenantResolver } from "./tenant.js";
import { loadFixture, TEST_BOT, TEST_OWNER, testTenant } from "./test-helpers.js";
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
});
