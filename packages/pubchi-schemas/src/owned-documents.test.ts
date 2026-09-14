import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parsePubchiAnswerV1 } from "./answer.js";
import { parsePubchiBotV1 } from "./bot.js";
import { parsePubchiConfigV1 } from "./config.js";
import { parsePubchiFeedDefinitionV1 } from "./feed.js";
import { parseRequestObjectV2 } from "./request.js";
import { parseTenantV1 } from "./tenant.js";
import { TEST_BOT, TEST_NOW, TEST_OWNER, TWO_HOP_BITCOIN_FEED } from "./vectors.js";

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(process.cwd(), "packages/pubchi-schemas/fixtures/valid", `${name}.json`), "utf8")) as Record<string, unknown>;
}

describe("owned multi-client documents", () => {
  it("preserves unknown members and ext on config, bot, and feed definitions", () => {
    const config = parsePubchiConfigV1({ ...fixture("config__app-cross-repo"), ext: { badge: { color: "orange" } }, future: ["kept"] });
    const bot = parsePubchiBotV1({ ...fixture("bot__custody-v1"), ext: { badge: { color: "orange" } }, future: ["kept"] });
    const feed = parsePubchiFeedDefinitionV1({ ...TWO_HOP_BITCOIN_FEED, ext: { badge: { color: "orange" } }, future: ["kept"] });

    expect(config).toMatchObject({ ok: true, value: { ext: { badge: { color: "orange" } }, future: ["kept"] } });
    expect(bot).toMatchObject({ ok: true, value: { ext: { badge: { color: "orange" } }, future: ["kept"] } });
    expect(feed).toMatchObject({ ok: true, value: { ext: { badge: { color: "orange" } }, future: ["kept"] } });
  });

  it("rejects over-cap owned documents without truncating them", () => {
    const oversized = { payload: "x".repeat(70_000) };
    expect(parsePubchiConfigV1({ ...fixture("config__app-cross-repo"), ext: oversized })).toEqual({
      ok: false,
      code: "DOCUMENT_TOO_LARGE",
    });
    expect(parsePubchiBotV1({ ...fixture("bot__custody-v1"), ext: oversized })).toEqual({
      ok: false,
      code: "DOCUMENT_TOO_LARGE",
    });
    expect(parsePubchiFeedDefinitionV1({ ...TWO_HOP_BITCOIN_FEED, ext: oversized })).toEqual({
      ok: false,
      code: "DOCUMENT_TOO_LARGE",
    });
  });

  it("scans ext and unknown members for forbidden shapes", () => {
    const result = parsePubchiConfigV1({ ...fixture("config__app-cross-repo"), ext: { nested: { api_key: "not-a-real-key" } } });
    expect(result).toEqual({ ok: false, code: "FORBIDDEN_SECRET" });
  });
});

describe("strict protocol schemas remain strict", () => {
  it("rejects unknown members in request v2, tenant, and answer", () => {
    expect(parseRequestObjectV2({
      schema: "pubchi-request-object-v2",
      version: 2,
      audience: "https://pubchi.example",
      asker: TEST_OWNER,
      bot: TEST_BOT,
      key_generation: 1,
      purpose: "ask",
      body_sha256: "a".repeat(64),
      issued_at: TEST_NOW,
      expires_at: TEST_NOW + 60,
      nonce: "b".repeat(64),
      signature: "c".repeat(128),
      unknown: true,
    }).ok).toBe(false);
    expect(parseTenantV1({ ...fixture("tenant__phase0"), unknown: true }).ok).toBe(false);
    expect(parsePubchiAnswerV1({
      schema: "pubchi-answer",
      version: 1,
      bot: TEST_BOT,
      owner: TEST_OWNER,
      generated_at: TEST_NOW,
      run_id: "run-test",
      purpose: "ask",
      question: "what is here?",
      summary: "The graph contains one user.",
      evidence: [],
      sources: [],
      tool_trace_summary: { tools: [], call_count: 0, truncated: false },
      policy_version: 1,
      unknown: true,
    }).ok).toBe(false);
  });
});
