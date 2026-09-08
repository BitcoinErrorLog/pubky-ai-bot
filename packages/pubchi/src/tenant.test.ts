import { describe, expect, it } from "vitest";
import {
  botUri,
  configUri,
  delegationUri,
  ownerBindingUri,
  signDeviceDelegationV1,
} from "@pubky/pubchi-schemas";
import { createTenantResolver } from "./tenant.js";
import {
  loadFixture,
  TEST_BOT,
  TEST_FAKE,
  TEST_FAKE_SEED,
  TEST_NOW,
  TEST_OWNER,
} from "./test-helpers.js";
import type { PublicHomeserverReader } from "./homeserver-read.js";

function readerOf(impl: (uri: string) => Promise<{ status: number; body: unknown }>): PublicHomeserverReader {
  return { getJson: impl };
}

function botDocument(bot = TEST_BOT, keyGeneration = 1) {
  return {
    schema: "pubchi-bot",
    version: 1,
    bot,
    owner: TEST_OWNER,
    display_name: "Pubchi",
    created_at: TEST_NOW - 100,
    backup_confirmed_at: null,
    homeserver_account: null,
    key_generation: keyGeneration,
  };
}

function bindingDocument(bot = TEST_BOT, keyGeneration = 1, status: "active" | "revoked" = "active") {
  return {
    schema: "pubchi-owner-binding",
    version: 1,
    owner: TEST_OWNER,
    bot,
    status,
    key_generation: keyGeneration,
    created_at: TEST_NOW - 100,
    updated_at: TEST_NOW - 10,
  };
}

function configDocument(tier: "read-only" | "assisted" | "autonomous") {
  return {
    ...loadFixture("valid/config__app-cross-repo.json") as Record<string, unknown>,
    bot: TEST_BOT,
    owner: TEST_OWNER,
    tier,
    updated_at: TEST_NOW,
  };
}

describe("tenant resolution", () => {
  it("derives the bot and assisted tier from the owner's canonical documents", async () => {
    const resolver = createTenantResolver(readerOf(async (uri) => {
      if (uri === botUri(TEST_OWNER)) return { status: 200, body: botDocument() };
      if (uri === ownerBindingUri(TEST_OWNER, TEST_BOT)) return { status: 200, body: bindingDocument() };
      if (uri === configUri(TEST_OWNER)) return { status: 200, body: configDocument("assisted") };
      throw new Error(`unexpected URI ${uri}`);
    }));
    const out = await resolver.resolve(TEST_OWNER, TEST_BOT);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.tenant.bot).toBe(TEST_BOT);
      expect(out.tenant.owner).toBe(TEST_OWNER);
      expect(out.tenant.tier).toBe("assisted");
      expect(out.tenant.budgets.per_request_output_tokens).toBe(4_000);
    }
    expect(resolver.cacheStatus?.(TEST_OWNER, TEST_BOT)).toEqual({ tenant: "hit", delegation: "miss" });
  });

  it("rejects a request-selected bot before reading its binding", async () => {
    const reads: string[] = [];
    const resolver = createTenantResolver(readerOf(async (uri) => {
      reads.push(uri);
      return { status: 200, body: botDocument() };
    }));
    await expect(resolver.resolve(TEST_OWNER, TEST_FAKE)).resolves.toEqual({ ok: false, code: "BOT_MISMATCH" });
    expect(reads).toEqual([botUri(TEST_OWNER)]);
  });

  it.each([
    ["revoked binding", bindingDocument(TEST_BOT, 1, "revoked")],
    ["generation mismatch", bindingDocument(TEST_BOT, 2)],
  ])("rejects %s", async (_name, binding) => {
    const resolver = createTenantResolver(readerOf(async (uri) => {
      if (uri === botUri(TEST_OWNER)) return { status: 200, body: botDocument() };
      return { status: 200, body: binding };
    }));
    await expect(resolver.resolve(TEST_OWNER, TEST_BOT)).resolves.toEqual({
      ok: false,
      code: "TENANT_NOT_ENROLLED",
    });
  });

  it("caps autonomous config at assisted and logs the cap", async () => {
    const events: string[] = [];
    const resolver = createTenantResolver(readerOf(async (uri) => {
      if (uri === botUri(TEST_OWNER)) return { status: 200, body: botDocument() };
      if (uri === ownerBindingUri(TEST_OWNER, TEST_BOT)) return { status: 200, body: bindingDocument() };
      return { status: 200, body: configDocument("autonomous") };
    }), { logEvent: (event) => events.push(event) });
    const out = await resolver.resolve(TEST_OWNER, TEST_BOT);
    expect(out.ok && out.tenant.tier).toBe("assisted");
    expect(events).toEqual(["autonomous_tier_capped_at_assisted"]);
  });

  it("defaults a missing config to read-only", async () => {
    const resolver = createTenantResolver(readerOf(async (uri) => {
      if (uri === botUri(TEST_OWNER)) return { status: 200, body: botDocument() };
      if (uri === ownerBindingUri(TEST_OWNER, TEST_BOT)) return { status: 200, body: bindingDocument() };
      return { status: 404, body: null };
    }));
    const out = await resolver.resolve(TEST_OWNER, TEST_BOT);
    expect(out.ok && out.tenant.tier).toBe("read-only");
  });

  it.each([
    ["garbage bot document", 200, botUri(TEST_OWNER), { garbage: true }],
    ["failed bot document", 503, botUri(TEST_OWNER), null],
    ["garbage config document", 200, configUri(TEST_OWNER), { garbage: true }],
  ])("fails closed for %s and does not broaden legacy fallback", async (_name, status, failingUri, body) => {
    const reads: string[] = [];
    const resolver = createTenantResolver(readerOf(async (uri) => {
      reads.push(uri);
      if (uri === failingUri) return { status, body };
      if (uri === botUri(TEST_OWNER)) return { status: 200, body: botDocument() };
      if (uri === ownerBindingUri(TEST_OWNER, TEST_BOT)) return { status: 200, body: bindingDocument() };
      return { status: 404, body: null };
    }));
    const out = await resolver.resolve(TEST_OWNER, TEST_BOT);
    expect(out.ok).toBe(false);
    expect(reads).toContain(failingUri);
    if (failingUri === botUri(TEST_OWNER)) {
      expect(reads).not.toContain(ownerBindingUri(TEST_OWNER, TEST_BOT));
    } else if (failingUri === configUri(TEST_OWNER)) {
      expect(reads).toEqual([botUri(TEST_OWNER), ownerBindingUri(TEST_OWNER, TEST_BOT), configUri(TEST_OWNER)]);
    }
  });

  it("keeps legacy binding-only owners read-only and logs once per cache window", async () => {
    const events: string[] = [];
    let reads = 0;
    let now = 1_000;
    const legacy = loadFixture("valid/owner-binding__active.json");
    const resolver = createTenantResolver(readerOf(async (uri) => {
      reads += 1;
      if (uri === botUri(TEST_OWNER)) return { status: 404, body: null };
      return { status: 200, body: legacy };
    }), { now: () => now, logEvent: (event) => events.push(event) });
    const first = await resolver.resolve(TEST_OWNER, TEST_BOT);
    expect(first.ok && first.tenant.tier).toBe("read-only");
    now = 10_000;
    await resolver.resolve(TEST_OWNER, TEST_BOT);
    expect(reads).toBe(2);
    expect(events).toEqual(["legacy_binding_without_bot_json"]);
  });

  it("negative-caches UPSTREAM_UNAVAILABLE for 30s per owner", async () => {
    let hits = 0;
    let now = 1_000;
    const resolver = createTenantResolver(
      readerOf(async () => {
        hits += 1;
        throw new Error("homeserver down");
      }),
      { now: () => now, fetchLimiter: { take: () => true } },
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

  it("caches binding and config for 15s, then honors a canonical re-mint", async () => {
    const reads = new Map<string, number>();
    let now = 1_000;
    let currentBot = TEST_BOT;
    const resolver = createTenantResolver(
      readerOf(async (uri) => {
        reads.set(uri, (reads.get(uri) ?? 0) + 1);
        if (uri === botUri(TEST_OWNER)) return {
          status: 200,
          body: botDocument(currentBot, currentBot === TEST_BOT ? 1 : 2),
        };
        if (uri === ownerBindingUri(TEST_OWNER, currentBot)) return {
          status: 200,
          body: bindingDocument(currentBot, currentBot === TEST_BOT ? 1 : 2),
        };
        return { status: 200, body: { ...configDocument("assisted"), bot: currentBot } };
      }),
      { now: () => now, fetchLimiter: { take: () => true } },
    );
    await resolver.resolve(TEST_OWNER, TEST_BOT);
    now = 10_000;
    await resolver.resolve(TEST_OWNER, TEST_BOT);
    expect(reads.get(ownerBindingUri(TEST_OWNER, TEST_BOT))).toBe(1);
    expect(reads.get(configUri(TEST_OWNER))).toBe(1);

    currentBot = TEST_FAKE;
    now = 16_001;
    const old = await resolver.resolve(TEST_OWNER, TEST_BOT);
    expect(old).toEqual({ ok: false, code: "BOT_MISMATCH" });
    const next = await resolver.resolve(TEST_OWNER, TEST_FAKE);
    expect(next.ok && next.tenant.bot).toBe(TEST_FAKE);
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
      if (i < 2) expect(out).toEqual({ ok: false, code: "TENANT_NOT_ENROLLED" });
      else expect(out).toMatchObject({ ok: false, code: "UPSTREAM_UNAVAILABLE", cause: "asker_fetch_limited" });
    }
    expect(hits).toBe(4);
    // Refill is 2 fetches per 60s per victim: one more fetch after 30s.
    now = 31_000;
    await resolver.resolve(TEST_OWNER, "bot-10");
    expect(hits).toBe(5);
    await resolver.resolve(TEST_OWNER, "bot-11");
    expect(hits).toBe(5);
    // Delegation fetches share the same per-victim bucket: 30s later one token
    // has refilled, so exactly one delegation fetch is allowed through.
    now = 61_001;
    const delegated = await resolver.resolveDelegation(TEST_OWNER, TEST_FAKE, TEST_BOT, "who-tagged-me", TEST_NOW);
    expect(delegated).toEqual({ ok: false, code: "DELEGATION_NOT_FOUND" });
    expect(hits).toBe(6);
    const blocked = await resolver.resolveDelegation(TEST_OWNER, "signer-other", TEST_BOT, "who-tagged-me", TEST_NOW);
    expect(blocked).toEqual({ ok: false, code: "UPSTREAM_UNAVAILABLE", cause: "asker_fetch_limited" });
    expect(hits).toBe(6);
  });
});
