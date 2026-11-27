import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { clearSwitchCache, setSwitch, switchOn } from "../packages/bot-kit/src/queue/switch-store.js";
import { declaredAutomation } from "../packages/bot-kit/src/policy/policy.js";
import { embedDevice, embedThreads } from "../packages/bot-kit/src/knowledge/embed.js";
import { modelPlanPubchi } from "../packages/bot-kit/src/nlq/model-planner.js";
import { createPubchiBrainServe, PROVIDER_STATE_KEYS } from "../src/pubchi/brain-serve.js";
import { memoryTokenBudget } from "../src/pubchi/budget.js";
import { scanForbiddenPublicState } from "../src/pubchi-schemas/forbidden.js";
import { runAsk } from "../src/pubchi/ask.js";
import { dummyNlqOpts, TEST_BOT, TEST_NOW, TEST_OWNER, testTenant } from "../src/pubchi/test-helpers.js";
import type { Brain } from "../packages/bot-kit/src/brain/types.js";
import { nlqResult } from "../packages/bot-kit/src/nlq/types.js";

describe("Wave R2 regressions", () => {
  it("switch-store coalesces switchOn to 1 SQL query and never latches kill_switch on stage pause", async () => {
    clearSwitchCache();
    let legacyDisabled = false;
    const switches = new Map<string, boolean>();
    let queries = 0;
    const db = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        queries += 1;
        if (sql.includes("INSERT INTO switches")) {
          if (sql.includes("'global'")) {
            switches.set("global", Boolean(params?.[0]));
          } else {
            switches.set(String(params?.[0]), Boolean(params?.[1]));
          }
          return { rows: [] };
        }
        if (sql.includes("UPDATE kill_switch")) {
          legacyDisabled = Boolean(params?.[0]);
          return { rows: [] };
        }
        const name = String(params?.[0] ?? "");
        const switch_on = switches.get("global") === true || switches.get(name) === true;
        return { rows: [{ legacy_disabled: legacyDisabled, switch_on }] };
      }),
    };

    await setSwitch(db as never, "replies", true);
    expect(legacyDisabled).toBe(false);
    queries = 0;
    expect(await switchOn(db as never, "replies")).toBe(true);
    expect(queries).toBe(1);
    // Cache hit avoids a second query within TTL
    expect(await switchOn(db as never, "replies")).toBe(true);
    expect(queries).toBe(1);
    // Unrelated stages stay unblocked
    expect(await switchOn(db as never, "generation")).toBe(false);
    // Resuming clears stage cleanly and invalidates cache immediately
    await setSwitch(db as never, "replies", false);
    expect(await switchOn(db as never, "replies")).toBe(false);
    expect(legacyDisabled).toBe(false);
  });

  it("routes legacy kimi-k3 synonym-hosted tenants to deploymentBrain and allows prompt_cache_key", () => {
    const deploymentBrain = {
      capabilities: { name: "kimi-k3.1-pro", providerId: "moonshot", supportsTools: true, supportsImages: true, maxContextTokens: 128_000, samplingDefaults: { temperature: 1 } },
      temperature: 1,
      generate: vi.fn(),
    } as unknown as Brain;
    const resolve = createPubchiBrainServe({ deploymentBrain, hostedModel: "kimi-k3.1-pro" });
    const tenant = testTenant({
      brain: {
        adapter: "vercel-ai",
        execution: "synonym-hosted",
        provider_id: "moonshot",
        model_id: "kimi-k3",
        endpoint: null,
      },
    });
    const served = resolve(tenant);
    expect(served.ok).toBe(true);
    expect(PROVIDER_STATE_KEYS).not.toContain("prompt_cache_key");
  });

  it("allows browser device signers full daily ceiling instead of silent 25% throttle", async () => {
    const budget = memoryTokenBudget({ dailyCeiling: 100_000, perRequestCap: 50_000 });
    const tenant = testTenant();
    const signer = "a".repeat(52);
    const r1 = await budget.reserve(tenant, 40_000, signer);
    expect(r1.ok).toBe(true);
    const r2 = await budget.reserve(tenant, 40_000, signer);
    expect(r2.ok).toBe(true);
    const r3 = await budget.reserve(tenant, 30_000, signer);
    expect(r3.ok).toBe(false);
  });

  it("rejects real BIP39 mnemonics while accepting ordinary 12-word lowercase sentences", () => {
    expect(
      scanForbiddenPublicState({
        note: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
      }).ok,
    ).toBe(false);
    expect(
      scanForbiddenPublicState({
        note: "exploring bitcoin lightning pubky homeservers protocols decentralization privacy cryptography consensus wallets relays nodes",
      }).ok,
    ).toBe(true);
  });

  it("does not silently ignore human bios mentioning bot, robot, or automation", () => {
    expect(declaredAutomation({ name: "Alex", bio: "building bitcoin automation tools and robots" })).toBe(false);
    expect(declaredAutomation({ name: "Sam", bio: "fighting spam bots on Pubky" })).toBe(false);
    expect(declaredAutomation({ name: "Relay Bot", bio: null })).toBe(true);
    expect(declaredAutomation({ name: "n", bio: "I am an automated account" })).toBe(true);
  });

  it("reads JEB_EMBED_DEVICE and JEB_EMBED_THREADS cleanly", () => {
    const prevDev = process.env.JEB_EMBED_DEVICE;
    const prevThreads = process.env.JEB_EMBED_THREADS;
    try {
      process.env.JEB_EMBED_DEVICE = "coreml";
      process.env.JEB_EMBED_THREADS = "4";
      expect(embedDevice()).toBe("coreml");
      expect(embedThreads()).toBe(4);
    } finally {
      if (prevDev === undefined) delete process.env.JEB_EMBED_DEVICE;
      else process.env.JEB_EMBED_DEVICE = prevDev;
      if (prevThreads === undefined) delete process.env.JEB_EMBED_THREADS;
      else process.env.JEB_EMBED_THREADS = prevThreads;
    }
  });

  it("puts static TOOL CATALOG in system prompt and disables thinking in modelPlanPubchi", async () => {
    let seenArgs: { messages: Array<{ role: string; content: string }>; providerOptions?: unknown } | undefined;
    const brain = {
      capabilities: { name: "kimi-k3.1-pro", providerId: "moonshot", supportsTools: false, supportsImages: false, maxContextTokens: 128_000, samplingDefaults: { temperature: 0 } },
      temperature: 0,
      generate: vi.fn(async (args) => {
        seenArgs = args;
        return { text: JSON.stringify({ tool: "profile_card", args: { pubky: TEST_OWNER }, confidence: 0.9 }), response: { messages: [] } };
      }),
    } as unknown as Brain;
    const res = await modelPlanPubchi({
      brain,
      question: "show profile",
      tools: { profile_card: { parameters: z.object({ pubky: z.string() }) } },
    });
    expect(res.ok).toBe(true);
    expect(seenArgs?.messages[0]?.role).toBe("system");
    expect(seenArgs?.messages[0]?.content).toContain("TOOL CATALOG");
    expect(seenArgs?.messages[1]?.content).not.toContain("TOOL CATALOG");
    expect(seenArgs?.providerOptions).toEqual({ moonshot: { thinking: { type: "disabled" } } });
  });

  it("passes knowledge source_excerpts and full post excerpts to brain composer", async () => {
    const prompts: string[] = [];
    const brain = {
      capabilities: { name: "kimi-k3.1-pro", providerId: "moonshot", supportsTools: false, supportsImages: false, maxContextTokens: 128_000, samplingDefaults: { temperature: 0 } },
      temperature: 0,
      generate: vi.fn(async (args) => {
        prompts.push(String(args.messages.at(-1)?.content ?? ""));
        return { text: JSON.stringify({ summary: "Pubky homeservers store signed user blobs over PKARR." }), response: { messages: [] } };
      }),
    } as unknown as Brain;

    const out = await runAsk({
      tenant: testTenant(),
      body: { question: "how do pubky homeservers store blobs?" },
      now: TEST_NOW * 1000,
      runId: "r2-excerpt-test",
      nlq: async () =>
        nlqResult({
          outcome: "ok",
          reason: "ok",
          intent: "explain_pubky",
          knowledgeRoute: "deterministic",
          planned: [{ tool: "search_knowledge", args: { query: "homeserver blobs" } }],
          results: [
            {
              chunks: [
                {
                  title: "Homeserver Storage",
                  url: "https://github.com/pubky/pubky-core/blob/main/README.md",
                  snippet: "UNIQUE_EXCERPT_MARKER_42: Homeservers persist content-addressed public blobs under /pub/.",
                },
              ],
            },
          ],
        }),
      nlqOpts: dummyNlqOpts(),
      brain,
    });
    expect(out.ok).toBe(true);
    expect(prompts.some((p) => p.includes("UNIQUE_EXCERPT_MARKER_42"))).toBe(true);
  });
});
