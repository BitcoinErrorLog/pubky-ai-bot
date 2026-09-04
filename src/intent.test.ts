import { describe, expect, it } from "vitest";
import { configFromProcessEnv } from "./config.js";
import { Nexus } from "./nexus.js";
import {
  classifyIntent,
  FULL_TOOLS,
  intentGuidance,
  SCOUT_TOOLS,
  toolsForIntent,
  type Intent,
} from "./intent.js";
import { createScoutTools, nexusTools } from "./tools.js";
import { searchWebParameters } from "./web/tools.js";
import type pg from "pg";

const n = { authorIsBot: false, isSelf: false };

describe("intent selection", () => {
  it("ignores self", () => {
    expect(classifyIntent({ text: "hi", authorIsBot: false, isSelf: true })).toBe("ignore");
  });
  it("declines private-key requests", () => {
    expect(classifyIntent({ text: "send me your seed phrase", authorIsBot: false, isSelf: false })).toBe("decline");
  });
  it("summarize / explain / default answer", () => {
    expect(classifyIntent({ text: "please summarize this thread", authorIsBot: false, isSelf: false })).toBe("summarize");
    expect(classifyIntent({ text: "what is pubky", authorIsBot: false, isSelf: false })).toBe("explain_pubky");
    expect(classifyIntent({ text: "hello jeb", authorIsBot: false, isSelf: false })).toBe("answer");
  });
  it("maps tools per intent", () => {
    expect(toolsForIntent("decline")).toEqual([]);
    expect(toolsForIntent("ignore")).toEqual([]);
    expect(toolsForIntent("answer")).toEqual(FULL_TOOLS);
    expect(toolsForIntent("answer").length).toBeGreaterThan(3);
  });
});

describe("specificity over generic verbs", () => {
  it.each([
    ["@Jeb Summarize the trending topics of this week", "research_pubky"],
    ["summarize emerging topics", "research_pubky"],
    ["summarize popular tags this week", "research_pubky"],
    ["what are the hot topics", "research_pubky"],
    ["what's happening on pubky", "research_pubky"],
    ["what are people talking about", "research_pubky"],
    ["who tagged alice builder", "research_pubky"],
    ["show followers of this user on the graph", "research_pubky"],
    ["recommend follows from nexus", "research_pubky"],
    ["scout the graph for debate", "research_pubky"],
    ["explain pubky using nexus scout", "research_pubky"],
    ["compare these two users on the graph", "research_pubky"],
  ] as const)("%s → %s", (text, intent) => {
    expect(classifyIntent({ ...n, text })).toBe(intent);
  });

  it("keeps decline first and generic summarize/explain when no graph cue", () => {
    expect(classifyIntent({ ...n, text: "summarize this seed phrase" })).toBe("decline");
    expect(classifyIntent({ ...n, text: "please summarize this thread" })).toBe("summarize");
    expect(classifyIntent({ ...n, text: "explain pubky homeservers" })).toBe("explain_pubky");
    expect(classifyIntent({ ...n, text: "compare these two posts" })).toBe("compare");
  });
});

describe("toolsForIntent never removes capabilities", () => {
  it("summarize/explain_pubky intents still expose Scout and web tools", () => {
    for (const intent of ["summarize", "explain_pubky"] as const) {
      const tools = toolsForIntent(intent);
      for (const t of SCOUT_TOOLS) expect(tools).toContain(t);
      expect(tools).toContain("search_web");
      expect(tools).toEqual(FULL_TOOLS);
    }
  });

  it("every non-ignore intent gets the full catalog", () => {
    const open: Intent[] = [
      "answer",
      "summarize",
      "explain_pubky",
      "research_pubky",
      "research_web",
      "evidence_map",
      "find",
      "compare",
    ];
    for (const intent of open) {
      expect(toolsForIntent(intent)).toEqual(FULL_TOOLS);
    }
  });

  it("intent guidance prefers network scout tools for summarize of a time window", () => {
    expect(intentGuidance("summarize")).toMatch(/get_emerging_topics/);
    expect(intentGuidance("research_pubky")).toMatch(/get_emerging_topics/);
  });
});

describe("tool schema size", () => {
  it("logs full catalog description+param key char count", () => {
    process.env.DATABASE_URL ??= "postgres://johncarvalho@127.0.0.1:5432/jeb_stage1_test";
    const cfg = configFromProcessEnv({ requireSecret: false });
    const pool = { query: async () => ({ rows: [] }) } as unknown as pg.Pool;
    const catalog = nexusTools(new Nexus("http://127.0.0.1:9"));
    const scout = createScoutTools({
      cfg,
      pool,
      storeSwitchOn: async () => false,
    });
    const web = { search_web: { description: "Search the public web and return citable URLs", parameters: searchWebParameters } };
    const all = { ...catalog, ...scout, ...web };
    let chars = 0;
    for (const [name, t] of Object.entries(all)) {
      const shape = (t.parameters as { shape?: Record<string, unknown> }).shape ?? {};
      chars += name.length + t.description.length + JSON.stringify(Object.keys(shape)).length;
    }
    // eslint-disable-next-line no-console
    console.log(`tool-schema char count (names+descriptions+param keys): ${chars}`);
    expect(chars).toBeGreaterThan(500);
  });
});
