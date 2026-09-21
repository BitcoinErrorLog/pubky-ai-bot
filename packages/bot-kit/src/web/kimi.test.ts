import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebToolError } from "./error.js";
import {
  assertKimiToolsUrl,
  KIMI_SEARCH_COST_USD,
  kimiWebSearch,
} from "./kimi.js";

const fixture = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "kimi-search-live.fixture.json"),
    "utf8",
  ),
) as { search_results: unknown[] };
const productionMissFixture = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../tests/fixtures/production-web-search-misses.json",
    ),
    "utf8",
  ),
) as { observed_web_query_ids: number[]; search_results: unknown[] };

const cfg = {
  webProvider: "kimi" as const,
  model: "kimi-k3",
  modelApiKey: "test-key",
  webTimeoutMs: 7_500,
  webPerMentionCap: 2,
  webDailyCeiling: 200,
  webAllowedAuthorities: new Set(["S", "A", "B"] as const),
  webPreferredDomains: ["forum.moonshot.ai", "platform.kimi.ai", "moonshot.ai", "kimi.ai", "kimi.com"],
  webFetchMaxChars: 12_000,
  webPriceBasicUsd: 0.002,
  webPriceProUsd: 0.003,
  webPriceFetchUsd: 0.002,
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function expectCode(promise: Promise<unknown>, code: string): Promise<WebToolError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(WebToolError);
    expect((error as WebToolError).code).toBe(code);
    return error as WebToolError;
  }
  throw new Error(`expected ${code}`);
}

describe("Kimi Web Search Basic", () => {
  it("pins the exact HTTPS host and path", () => {
    expect(() => assertKimiToolsUrl(new URL("https://api.moonshot.ai/v1/tools/search"))).not.toThrow();
    expect(() => assertKimiToolsUrl(new URL("https://api.moonshot.ai/v1/tools/search_pro"))).not.toThrow();
    expect(() => assertKimiToolsUrl(new URL("https://api.moonshot.ai/v1/tools/fetch"))).not.toThrow();
    expect(() => assertKimiToolsUrl(new URL("http://api.moonshot.ai/v1/tools/search"))).toThrow(/protocol/);
    expect(() => assertKimiToolsUrl(new URL("https://evil.example/v1/tools/search"))).toThrow(/host/);
    expect(() => assertKimiToolsUrl(new URL("https://api.moonshot.ai/v1/tools/other"))).toThrow(/path/);
    expect(() => assertKimiToolsUrl(new URL("https://user@api.moonshot.ai/v1/tools/search"))).toThrow(
      /credentials/,
    );
  });

  it("sends the documented Basic request and parses the captured live shape", async () => {
    let request: { url: string; init?: RequestInit } | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | string, init?: RequestInit) => {
        request = { url: String(input), init };
        return new Response(JSON.stringify(fixture), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const out = await kimiWebSearch(cfg, {
      query: "Pubky protocol latest release 2026 GitHub",
      mode: "basic",
      limit: 5,
      timeoutSeconds: 7,
    });
    expect(request?.url).toBe("https://api.moonshot.ai/v1/tools/search");
    expect(request?.init?.method).toBe("POST");
    expect(request?.init?.redirect).toBe("error");
    expect(request?.init?.headers).toMatchObject({
      authorization: "Bearer test-key",
      "content-type": "application/json",
    });
    expect(JSON.parse(String(request?.init?.body))).toEqual({
      text_query: "Pubky protocol latest release 2026 GitHub",
      limit: 5,
      timeout_seconds: 7,
      include_content: false,
    });
    expect(out).toEqual({
      provider: "kimi",
      operation: "basic",
      billable: true,
      cost_usd: KIMI_SEARCH_COST_USD,
      sources: [
        {
          title: "Pubky",
          url: "https://github.com/pubky/pubky-core",
          snippet:
            "Pubky is an open protocol for building censorship-resistant applications where users own their identity, data, and connections.",
          source_domain: "Github",
          authority: "S",
        },
      ],
    });
  });

  it("classifies empty and malformed responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ search_results: [] }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ results: [] }), { status: 200 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ search_results: [{ title: "missing fields" }] }), { status: 200 }),
        )
        .mockResolvedValueOnce(new Response("not json", { status: 200 })),
    );
    await expect(kimiWebSearch(cfg, { query: "empty", mode: "basic" })).resolves.toMatchObject({
      billable: false,
      cost_usd: 0,
      sources: [],
    });
    expect((await expectCode(kimiWebSearch(cfg, { query: "missing array", mode: "basic" }), "PARSE")).billedCostUsd).toBe(0);
    expect((await expectCode(kimiWebSearch(cfg, { query: "malformed row", mode: "basic" }), "PARSE")).billedCostUsd).toBe(0.002);
    expect((await expectCode(kimiWebSearch(cfg, { query: "non-json", mode: "basic" }), "PARSE")).billedCostUsd).toBe(0);
  });

  it("drops non-HTTPS source URLs before returning adapter results", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            search_results: [
              { authority: "S", title: "Script", url: "javascript:alert(1)", snippet: "unsafe" },
              { authority: "S", title: "Plain HTTP", url: "http://example.com", snippet: "insecure" },
              { authority: "S", title: "Secure", url: "https://example.com", snippet: "safe" },
            ],
          }),
          { status: 200 },
        ),
      ),
    );
    const result = await kimiWebSearch(cfg, { query: "schemes", mode: "basic" });
    expect(result.sources.map((source) => source.url)).toEqual(["https://example.com"]);
    expect(result.cost_usd).toBe(0.002);
  });

  it("uses a bounded official-source preference on the observed production miss", async () => {
    expect(productionMissFixture.observed_web_query_ids).toEqual([13, 14]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ search_results: productionMissFixture.search_results }), {
          status: 200,
        }),
      ),
    );
    const result = await kimiWebSearch(cfg, {
      query: "Kimi web search API changes this week migration developers",
      mode: "pro",
    });
    expect(result.sources.map((source) => source.url)).toEqual([
      "https://forum.moonshot.ai/t/new-web-search-api-is-now-avaliable/606",
      "https://github.com/Hmbown/CodeWhale/blob/main/docs/PROVIDERS.md",
      "https://www.kimi.ai/academy/kimi-code-cheat-sheet",
    ]);
    expect(result.sources.some((source) => source.authority === "C")).toBe(false);
  });

  it.each([
    [400, "HTTP"],
    [401, "AUTH"],
    [403, "AUTH"],
    [408, "TIMEOUT"],
    [429, "RATE_LIMIT"],
    [500, "HTTP"],
    [502, "HTTP"],
    [504, "TIMEOUT"],
  ])("maps HTTP %i to %s without exposing response text", async (status, code) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { message: "provider detail" } }), {
          status,
        }),
      ),
    );
    const error = await expectCode(kimiWebSearch(cfg, { query: "status" }), code);
    expect(error.message).toBe("web search unavailable");
  });

  it("maps the 7.5-second HTTP abort to TIMEOUT", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: URL | string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
      ),
    );
    const pending = expectCode(kimiWebSearch(cfg, { query: "slow" }), "TIMEOUT");
    await vi.advanceTimersByTimeAsync(7_500);
    await pending;
  });

  it("fails closed on oversized responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(`{"search_results":[],"padding":"${"x".repeat(1_000_001)}"}`, { status: 200 })),
    );
    await expectCode(kimiWebSearch(cfg, { query: "oversized" }), "PARSE");
  });
});
