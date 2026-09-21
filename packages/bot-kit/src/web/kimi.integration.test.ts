import { describe, expect, it } from "vitest";
import { kimiWebSearch } from "./kimi.js";

const enabled = process.env.PUBCHI_KIMI_SEARCH_INTEGRATION === "1";
const live = enabled ? describe : describe.skip;

live("Kimi Web Search Basic staging integration", () => {
  it("returns screened-source inputs from the real endpoint", async () => {
    const apiKey = process.env.JEB_MODEL_API_KEY;
    const nexusUrl = process.env.JEB_NEXUS_URL ?? "";
    if (!apiKey) throw new Error("JEB_MODEL_API_KEY is required");
    if (!nexusUrl.includes("staging.pubky.app")) {
      throw new Error("JEB_NEXUS_URL must identify staging");
    }

    const result = await kimiWebSearch(
      {
        model: "kimi-k3",
        modelApiKey: apiKey,
        modelBaseUrl: "https://api.moonshot.ai/v1",
        webTimeoutMs: 7_500,
      },
      {
        query: "Pubky protocol official documentation",
        limit: 3,
      },
    );

    expect(result.provider).toBe("kimi");
    expect(result.billable).toBe(true);
    expect(result.cost_usd).toBe(0.002);
    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.sources.length).toBeLessThanOrEqual(3);
    for (const source of result.sources) {
      expect(source.title).toEqual(expect.any(String));
      expect(source.snippet).toEqual(expect.any(String));
      expect(new URL(source.url).protocol).toBe("https:");
    }
  });
});
