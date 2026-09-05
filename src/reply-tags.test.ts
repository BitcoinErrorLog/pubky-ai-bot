import { afterEach, describe, expect, it } from "vitest";
import { SCOUT_TOOLS } from "./intent.js";
import {
  deriveCategories,
  isValidTagLabel,
  MAX_REPLY_TAGS,
  PRODUCT_CATEGORIES,
  productCategory,
  putArtifactTag,
  putReplyTags,
  REPLY_TAG_VOCABULARY,
  suggestTags,
  toolsUsedInTrace,
} from "./reply-tags.js";
import { configFromProcessEnv } from "./config.js";
import type { Transport } from "./homeserver.js";

const BOT_PK = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REPLY_URI = `pubky://${BOT_PK}/pub/pubky.app/posts/0000000000001`;
const FOREIGN_URI = "pubky://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/pub/pubky.app/posts/0000000000001";

function traceWith(...toolNames: string[]): unknown[] {
  return [{ toolCalls: toolNames.map((name) => ({ name, args: {} })) }];
}

export const DERIVE_CATEGORY_CASES: Array<{
  name: string;
  intent: string;
  toolTrace?: unknown[];
  products?: string[];
  expected: string[];
}> = [
    { name: "plain answer, no tools or products", intent: "answer", expected: ["answer"] },
    { name: "decline intent → declined, never answer", intent: "decline", expected: ["declined"] },
    { name: "summarize intent → summary, never answer", intent: "summarize", expected: ["summary"] },
    { name: "evidence_map intent → evidence-map, never answer", intent: "evidence_map", expected: ["evidence-map"] },
    { name: "pubky product touched", intent: "answer", products: ["pubky-core"], expected: ["answer", "pubky"] },
    { name: "pkarr counts as pubky", intent: "answer", products: ["pkarr"], expected: ["answer", "pubky"] },
    { name: "nexus-scout counts as pubky", intent: "answer", products: ["nexus-scout"], expected: ["answer", "pubky"] },
    { name: "bitkit product touched", intent: "answer", products: ["bitkit"], expected: ["answer", "bitkit"] },
    { name: "paykit product touched", intent: "answer", products: ["paykit"], expected: ["answer", "paykit"] },
    { name: "unmapped product adds no label", intent: "answer", products: ["atomicity"], expected: ["answer"] },
    { name: "scout tool used → graph", intent: "answer", toolTrace: traceWith("get_topic_brief"), expected: ["answer", "graph"] },
    { name: "raw cypher escape hatch → graph", intent: "answer", toolTrace: traceWith("query_graph"), expected: ["answer", "graph"] },
    { name: "nexus read tool only → no graph", intent: "answer", toolTrace: traceWith("get_post", "get_thread"), expected: ["answer"] },
    { name: "search_knowledge is not a scout tool", intent: "answer", toolTrace: traceWith("search_knowledge"), expected: ["answer"] },
    {
      name: "evidence_map with scout tool and pubky product",
      intent: "evidence_map",
      toolTrace: traceWith("get_debate_map"),
      products: ["pubky-app"],
      expected: ["evidence-map", "pubky", "graph"],
    },
    {
      name: "summary with scout tool",
      intent: "summarize",
      toolTrace: traceWith("scout_get_thread"),
      expected: ["summary", "graph"],
    },
    {
      name: "cap at MAX_REPLY_TAGS in vocabulary precedence order",
      intent: "answer",
      products: ["pubky-core", "bitkit", "paykit"],
      toolTrace: traceWith("search_posts"),
      expected: ["answer", "pubky", "bitkit", "paykit", "graph"],
    },
    {
      name: "malformed trace entries are ignored",
      intent: "answer",
      toolTrace: [null, { toolCalls: "nope" }, { toolCalls: [{ name: 7 }] }, { screening_flags: [] }],
      expected: ["answer"],
    },
];

describe("deriveCategories (table-driven)", () => {
  for (const c of DERIVE_CATEGORY_CASES) {
    it(c.name, () => {
      const got = deriveCategories({ intent: c.intent, toolTrace: c.toolTrace, products: c.products });
      expect(got).toEqual(c.expected);
      expect(got.length).toBeLessThanOrEqual(MAX_REPLY_TAGS);
    });
  }
});

describe("suggestTags byte-identity vs deriveCategories fixtures", () => {
  for (const c of DERIVE_CATEGORY_CASES) {
    it(c.name, () => {
      const jeb = deriveCategories({ intent: c.intent, toolTrace: c.toolTrace, products: c.products });
      const mapped = (c.products ?? [])
        .map((p) => productCategory(p))
        .filter((x): x is NonNullable<typeof x> => x !== null);
      const kit = suggestTags({
        intent: c.intent,
        toolTrace: c.toolTrace ?? [],
        products: mapped,
        vocab: REPLY_TAG_VOCABULARY,
        precedence: PRODUCT_CATEGORIES,
        graphTools: SCOUT_TOOLS,
      });
      expect(JSON.stringify(kit)).toBe(JSON.stringify(c.expected));
      expect(JSON.stringify(jeb)).toBe(JSON.stringify(kit));
    });
  }
});

describe("label validity against the spec limits", () => {
  it("every vocabulary label passes the spec limits (1-20 chars, no comma/colon/whitespace)", () => {
    for (const label of REPLY_TAG_VOCABULARY) {
      expect(isValidTagLabel(label), label).toBe(true);
      expect(label.length).toBeGreaterThanOrEqual(1);
      expect(label.length).toBeLessThanOrEqual(20);
      expect(label).toMatch(/^[^,\s:]+$/);
    }
  });

  it("rejects empty, overlong, and comma/colon/whitespace labels", () => {
    expect(isValidTagLabel("")).toBe(false);
    expect(isValidTagLabel("x".repeat(21))).toBe(false);
    expect(isValidTagLabel("a,b")).toBe(false);
    expect(isValidTagLabel("a:b")).toBe(false);
    expect(isValidTagLabel("a b")).toBe(false);
    expect(isValidTagLabel("a\tb")).toBe(false);
    expect(isValidTagLabel("a\nb")).toBe(false);
    expect(isValidTagLabel("x".repeat(20))).toBe(true);
  });

  it("productCategory maps known products and ignores the rest", () => {
    expect(productCategory("pubky-core")).toBe("pubky");
    expect(productCategory("pubky-app-specs")).toBe("pubky");
    expect(productCategory("pubky")).toBe("pubky");
    expect(productCategory("pkarr")).toBe("pubky");
    expect(productCategory("nexus-scout")).toBe("pubky");
    expect(productCategory("bitkit")).toBe("bitkit");
    expect(productCategory("paykit")).toBe("paykit");
    expect(productCategory("atomicity")).toBeNull();
  });

  it("toolsUsedInTrace extracts tool names from the trace shape", () => {
    expect(toolsUsedInTrace(traceWith("get_post", "query_graph"))).toEqual(["get_post", "query_graph"]);
    expect(toolsUsedInTrace([])).toEqual([]);
  });
});

class TagFakeTransport implements Transport {
  botPk = BOT_PK;
  tagPuts: Array<{ path: string; json: { uri?: string; label?: string } }> = [];
  failNext = 0;

  async putJson(path: string, json: unknown): Promise<void> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error("homeserver tag PUT failed");
    }
    this.tagPuts.push({ path, json: json as { uri?: string; label?: string } });
  }

  async putBytes(): Promise<void> {}
  async getJson(): Promise<unknown> {
    return {};
  }
  async listPosts(): Promise<Array<{ parent?: string; uri: string }>> {
    return [];
  }
  async reauth(): Promise<void> {}
  async deleteJson(): Promise<void> {}
}

describe("putReplyTags", () => {
  it("PUTs one tag per label at /pub/pubky.app/tags/ and returns the tag URIs", async () => {
    const t = new TagFakeTransport();
    const uris = await putReplyTags(t, REPLY_URI, ["answer", "pubky"]);
    expect(t.tagPuts).toHaveLength(2);
    for (const [i, put] of t.tagPuts.entries()) {
      expect(put.path).toMatch(/^\/pub\/pubky\.app\/tags\/.+/);
      expect(put.json.uri).toBe(REPLY_URI);
      expect(put.json.label).toBe(["answer", "pubky"][i]);
    }
    expect(uris).toHaveLength(2);
    for (const uri of uris) {
      expect(uri).toMatch(new RegExp(`^pubky://${BOT_PK}/pub/pubky\\.app/tags/.+`));
    }
  });

  it("is idempotent: re-PUT targets the same paths and URIs (tag id = hash of uri+label)", async () => {
    const first = new TagFakeTransport();
    const second = new TagFakeTransport();
    const uris1 = await putReplyTags(first, REPLY_URI, ["answer", "graph"]);
    const uris2 = await putReplyTags(second, REPLY_URI, ["answer", "graph"]);
    expect(uris2).toEqual(uris1);
    expect(second.tagPuts.map((p) => p.path)).toEqual(first.tagPuts.map((p) => p.path));
  });

  it("dedupes duplicate labels in one call by (post uri, label)", async () => {
    const t = new TagFakeTransport();
    const uris = await putReplyTags(t, REPLY_URI, ["answer", "answer", "pubky"]);
    expect(t.tagPuts).toHaveLength(2);
    expect(uris).toHaveLength(2);
    expect(t.tagPuts.map((p) => p.json.label)).toEqual(["answer", "pubky"]);
  });

  it("rejects a foreign URI before any PUT (never tag other people's posts)", async () => {
    const t = new TagFakeTransport();
    await expect(putReplyTags(t, FOREIGN_URI, ["answer"])).rejects.toThrow(/not authored by the bot key/);
    expect(t.tagPuts).toHaveLength(0);
  });

  it("putArtifactTag writes a vocab tag on a foreign post URI", async () => {
    const t = new TagFakeTransport();
    const url = await putArtifactTag(t, FOREIGN_URI, "debate");
    expect(t.tagPuts).toHaveLength(1);
    expect(t.tagPuts[0]?.json.uri).toBe(FOREIGN_URI);
    expect(t.tagPuts[0]?.json.label).toBe("debate");
    expect(url).toMatch(new RegExp(`^pubky://${BOT_PK}/pub/pubky\\.app/tags/.+`));
  });

  it("rejects style-invalid labels before any PUT", async () => {
    const t = new TagFakeTransport();
    await expect(putReplyTags(t, REPLY_URI, ["Hello"])).rejects.toThrow(/invalid tag label/);
    expect(t.tagPuts).toHaveLength(0);
  });

  it("accepts an open-vocabulary label that passes style rules", async () => {
    const t = new TagFakeTransport();
    const uris = await putReplyTags(t, REPLY_URI, ["hello"]);
    expect(t.tagPuts).toHaveLength(1);
    expect(uris).toHaveLength(1);
  });
});

describe("JEB_SELF_TAGS env gate", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  function parseSelfTags(): boolean {
    process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://127.0.0.1:5432/postgres";
    return configFromProcessEnv({ requireSecret: false }).selfTags;
  }

  it("defaults to enabled when unset", () => {
    delete process.env.JEB_SELF_TAGS;
    expect(parseSelfTags()).toBe(true);
  });

  it("JEB_SELF_TAGS=0 disables the feature", () => {
    process.env.JEB_SELF_TAGS = "0";
    expect(parseSelfTags()).toBe(false);
  });
});
