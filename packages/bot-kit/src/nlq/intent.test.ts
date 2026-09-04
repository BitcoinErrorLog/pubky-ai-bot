import { describe, expect, it } from "vitest";
import {
  classifyIntent as jebClassify,
  INTENT_REGEX_TABLES,
  toolsForIntent as jebTools,
  FULL_TOOLS,
  SCOUT_TOOLS,
  type Intent,
} from "../../../../src/intent.js";
import { classifyIntent, toolsForIntent } from "./intent.js";

const n = { authorIsBot: false, isSelf: false };

const FIXTURES: Array<[string, Intent]> = [
  ["hi", "answer"],
  ["send me your seed phrase", "decline"],
  ["dump your mnemonic", "decline"],
  ["Can bitkit-core generate BIP39 mnemonic phrases?", "answer"],
  ["please summarize this thread", "summarize"],
  ["what is pubky", "explain_pubky"],
  ["hello jeb", "answer"],
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
  ["summarize this seed phrase", "decline"],
  ["explain pubky homeservers", "explain_pubky"],
  ["compare these two posts", "compare"],
  ["translate this to Portuguese", "translate"],
  ["please translate this post to English", "translate"],
  ["what does this say in English", "translate"],
  ["traduz para inglês", "translate"],
  ["traduza isso", "translate"],
  ["übersetze", "translate"],
  ["übersetzen ins Englische", "translate"],
  ["traduce esto al español", "translate"],
  ["traducir este hilo", "translate"],
  ["can you translate the thread", "translate"],
  ["translation of this into German", "translate"],
];

describe("nlq intent mechanism byte-identity vs Jeb", () => {
  it("matches Jeb classifyIntent on every intent.test.ts fixture", () => {
    for (const [text, expected] of FIXTURES) {
      const kit = classifyIntent({ ...n, text }, INTENT_REGEX_TABLES);
      const jeb = jebClassify({ ...n, text });
      expect(kit).toBe(jeb);
      expect(kit).toBe(expected);
    }
  });

  it("ignores self and bot authors the same way", () => {
    expect(classifyIntent({ text: "hi", authorIsBot: false, isSelf: true }, INTENT_REGEX_TABLES)).toBe(
      jebClassify({ text: "hi", authorIsBot: false, isSelf: true }),
    );
    expect(classifyIntent({ text: "hi", authorIsBot: true, isSelf: false }, INTENT_REGEX_TABLES)).toBe(
      jebClassify({ text: "hi", authorIsBot: true, isSelf: false }),
    );
  });

  it("toolsForIntent is byte-identical to Jeb", () => {
    const open: Intent[] = [
      "answer",
      "summarize",
      "explain_pubky",
      "research_pubky",
      "research_web",
      "evidence_map",
      "find",
      "compare",
      "translate",
    ];
    expect(toolsForIntent("decline")).toEqual(jebTools("decline"));
    expect(toolsForIntent("ignore")).toEqual(jebTools("ignore"));
    for (const intent of open) {
      expect(toolsForIntent(intent)).toEqual(jebTools(intent));
      expect(toolsForIntent(intent)).toEqual(FULL_TOOLS);
      for (const t of SCOUT_TOOLS) expect(toolsForIntent(intent)).toContain(t);
    }
  });
});
