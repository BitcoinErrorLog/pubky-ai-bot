import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { corpusProductNames, namesFromManifestYaml } from "./corpus-products.js";
import { defaultManifestPath } from "./run-ingest.js";
import { GRAPH_TAG_TOOLS, routeKnowledgeQuestion } from "./route.js";

const VIBES_BOARD = "What vibes are on the vibes board?";
const SUCCESS = [
  "What is Pubky Passport and how does recovery work?",
  "What's new in pubky-app 1.11?",
  "What’s new in pubky-app 1.11?",
  "What's the status of Paykit and Locks?",
  "What can I do on the Pubky Marketplace?",
] as const;

describe("knowledge routing", () => {
  it("routes both vibes board mentions to knowledge and withholds graph tools", () => {
    expect(routeKnowledgeQuestion(VIBES_BOARD)).toEqual({
      requireKnowledge: true,
      allowGraphTools: false,
    });
    expect(routeKnowledgeQuestion("What vibes are on the vibes portal?")).toEqual({
      requireKnowledge: true,
      allowGraphTools: false,
    });
  });

  it("routes a vibes hostname to knowledge", () => {
    expect(routeKnowledgeQuestion("What vibes are listed at vibes.pubky.app?")).toEqual({
      requireKnowledge: true,
      allowGraphTools: false,
    });
    expect(routeKnowledgeQuestion("See https://vibes.pubky.app for the list").requireKnowledge).toBe(true);
  });

  it("keeps the four staging answers on knowledge and off graph tools", () => {
    for (const question of SUCCESS) {
      expect(routeKnowledgeQuestion(question), question).toEqual({
        requireKnowledge: true,
        allowGraphTools: false,
      });
    }
  });

  it("requires knowledge for what-is, what's-new, and status-of even without a product name", () => {
    expect(routeKnowledgeQuestion("What is a widget?").requireKnowledge).toBe(true);
    expect(routeKnowledgeQuestion("What's new today?").requireKnowledge).toBe(true);
    expect(routeKnowledgeQuestion("What's the status of the fridge?").requireKnowledge).toBe(true);
  });

  it("keeps graph tools for explicit posts, taggers, and network activity after a knowledge requirement", () => {
    expect(routeKnowledgeQuestion("Who tagged posts about Paykit?")).toEqual({
      requireKnowledge: true,
      allowGraphTools: true,
    });
    expect(routeKnowledgeQuestion("Who tagged posts about the vibes board?")).toEqual({
      requireKnowledge: true,
      allowGraphTools: true,
    });
    expect(routeKnowledgeQuestion("What's happening with Paykit?")).toEqual({
      requireKnowledge: true,
      allowGraphTools: true,
    });
    expect(routeKnowledgeQuestion("What is Graph Explorer and who tagged posts about it?")).toEqual({
      requireKnowledge: true,
      allowGraphTools: true,
    });
  });

  it("does not treat a product name's graph word as a network ask", () => {
    expect(routeKnowledgeQuestion("What is Graph Explorer?")).toEqual({
      requireKnowledge: true,
      allowGraphTools: false,
    });
    expect(routeKnowledgeQuestion("What is the semantic social graph?")).toEqual({
      requireKnowledge: true,
      allowGraphTools: false,
    });
  });

  it("leaves plain graph asks on graph tools without a knowledge requirement", () => {
    expect(routeKnowledgeQuestion("who tagged alice builder")).toEqual({
      requireKnowledge: false,
      allowGraphTools: true,
    });
    expect(routeKnowledgeQuestion("compare these two posts")).toEqual({
      requireKnowledge: false,
      allowGraphTools: true,
    });
    expect(routeKnowledgeQuestion("what's happening on the network")).toEqual({
      requireKnowledge: false,
      allowGraphTools: true,
    });
  });

  it("does not route greetings, translations, or version numbers", () => {
    expect(routeKnowledgeQuestion("hello jeb")).toEqual({
      requireKnowledge: false,
      allowGraphTools: false,
    });
    expect(routeKnowledgeQuestion("translate this to Portuguese")).toEqual({
      requireKnowledge: false,
      allowGraphTools: false,
    });
    expect(routeKnowledgeQuestion("What about release 1.11?").requireKnowledge).toBe(false);
    expect(routeKnowledgeQuestion("See e.g. the note").requireKnowledge).toBe(false);
  });

  it("covers manifest products and knowledge-base titles", () => {
    const yaml = readFileSync(defaultManifestPath(), "utf8");
    const fromManifest = namesFromManifestYaml(yaml);
    expect(fromManifest).toContain("bitkit");
    expect(fromManifest).toContain("pkarr");
    expect(fromManifest).toContain("pubky-app");
    const names = corpusProductNames();
    expect(names).toContain("bitkit");
    expect(names).toContain("vibes");
    expect(names).toContain("pubky passport");
    expect(routeKnowledgeQuestion("How does Bitkit work?", names).requireKnowledge).toBe(true);
    expect(routeKnowledgeQuestion("How does pkarr resolve names?", names).requireKnowledge).toBe(true);
    expect(routeKnowledgeQuestion("How does the weather work?", names).requireKnowledge).toBe(false);
  });

  it("lists the graph and tag catalog separately from search_knowledge", () => {
    expect(GRAPH_TAG_TOOLS).toContain("get_topic_brief");
    expect(GRAPH_TAG_TOOLS).toContain("get_tag_landscape");
    expect(GRAPH_TAG_TOOLS).toContain("search_posts_by_tag");
    expect(GRAPH_TAG_TOOLS).toContain("get_post");
    expect(GRAPH_TAG_TOOLS).not.toContain("search_knowledge");
    expect(GRAPH_TAG_TOOLS).not.toContain("search_web");
  });
});
