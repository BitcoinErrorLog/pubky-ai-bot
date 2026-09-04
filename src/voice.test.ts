import { describe, expect, it } from "vitest";
import { forbiddenHits, lintVoice, SHORT_REPLY_CITATION_CAP, SOURCES_MODE_CITATION_CAP } from "./voice.js";

function rules(result: ReturnType<typeof lintVoice>): string[] {
  return result.violations.map((v) => v.rule);
}

describe("voice linter: forbidden openers", () => {
  it("strips 'Great question!' and capitalizes the real answer", () => {
    const r = lintVoice("Great question! the answer is pkarr.");
    expect(r.text).toBe("The answer is pkarr.");
    expect(rules(r)).toContain("forbidden_opener");
  });

  it("strips stacked openers and greeting", () => {
    const r = lintVoice("Hello! Sure, I'd be happy to help. PKARR is a DNS-like layer.");
    expect(r.text).toBe("PKARR is a DNS-like layer.");
    expect(rules(r).filter((x) => x === "forbidden_opener").length).toBeGreaterThanOrEqual(2);
  });

  it("leaves a clean opening untouched", () => {
    const r = lintVoice("PKARR publishes public keys as DNS packets.");
    expect(r.text).toBe("PKARR publishes public keys as DNS packets.");
    expect(r.violations).toHaveLength(0);
  });
});

describe("voice linter: AI disclaimers and throat clearing", () => {
  it("removes 'As an AI' sentences", () => {
    const r = lintVoice("As an AI language model, I have limits. Homeservers store user data.");
    expect(r.text).toBe("Homeservers store user data.");
    expect(rules(r)).toContain("ai_disclaimer");
  });

  it("removes hedging spam and sign-offs", () => {
    const r = lintVoice("It's important to note that tags are claims. In conclusion, claimants matter. I hope this helps!");
    expect(r.text).toBe("Tags are claims. Claimants matter.");
    expect(rules(r)).toContain("throat_clearing");
  });
});

describe("voice linter: exclamations", () => {
  it("collapses runs of exclamation marks", () => {
    const r = lintVoice("This is huge!!! Really.");
    expect(r.text).toBe("This is huge! Really.");
    expect(rules(r)).toContain("exclamation_run");
  });

  it("caps total exclamation density", () => {
    const r = lintVoice("One! Two! Three! Four!");
    expect(r.text).toBe("One! Two! Three. Four.");
    expect(rules(r)).toContain("exclamation_density");
  });
});

describe("voice linter: emoji", () => {
  it("removes emoji including ZWJ sequences", () => {
    const r = lintVoice("Nice work 🚀 on the release 👍🏽.");
    expect(r.text).toBe("Nice work on the release.");
    expect(rules(r)).toContain("emoji");
  });
});

describe("voice linter: citation cap", () => {
  const urls = (n: number) =>
    Array.from({ length: n }, (_, i) => `https://example.com/doc${i}`).join(" ");

  it("keeps at most the cap in a short reply", () => {
    const r = lintVoice(`See ${urls(5)}`);
    expect((r.text.match(/https:\/\/example\.com/g) ?? []).length).toBe(SHORT_REPLY_CITATION_CAP);
    expect(rules(r)).toContain("citation_cap");
  });

  it("allows more citations in sources mode cap", () => {
    const r = lintVoice(`See ${urls(6)}`, { citationCap: SOURCES_MODE_CITATION_CAP });
    expect((r.text.match(/https:\/\/example\.com/g) ?? []).length).toBe(6);
    expect(r.violations).toHaveLength(0);
  });

  it("counts pubky URIs toward the cap", () => {
    const id = "a".repeat(52);
    const text = [1, 2, 3, 4].map((i) => `pubky://${id}/pub/pubky.app/posts/000000000000${i}`).join(" ");
    const r = lintVoice(text);
    expect((r.text.match(/pubky:\/\//g) ?? []).length).toBe(SHORT_REPLY_CITATION_CAP);
    expect(rules(r)).toContain("citation_cap");
  });
});

describe("voice linter: preservation", () => {
  it("does not mutilate a normal technical answer", () => {
    const good =
      "Homeservers are always-on web servers that hold user data under the user's key. Signup on the public homeserver needs an invite token; see https://pubky.org and the repo docs.";
    const r = lintVoice(good);
    expect(r.text).toBe(good);
    expect(r.violations).toHaveLength(0);
  });

  it("keeps a leading pubky URI lowercase", () => {
    const text = `pubky://${"b".repeat(52)}/pub/pubky.app/posts/0000000000001 is the source.`;
    const r = lintVoice(`Great question! ${text}`);
    expect(r.text.startsWith("pubky://")).toBe(true);
  });
});

describe("voice linter: markdown emphasis", () => {
  it("strips bold and underscore emphasis, keeps list dashes", () => {
    const r = lintVoice("Use **pkarr** and __homeservers__.\n- first\n- second");
    expect(r.text).toBe("Use pkarr and homeservers.\n- first\n- second");
    expect(rules(r)).toContain("markdown_emphasis");
  });

  it("strips leading markdown headers", () => {
    const r = lintVoice("# Title\n## Sub\nThe body.");
    expect(r.text).toBe("Title\nSub\nThe body.");
    expect(rules(r)).toContain("markdown_emphasis");
  });

  it("leaves headings and bold intact when allowMarkdown is set", () => {
    const text = "## Title\nUse **pkarr** here.";
    const r = lintVoice(text, { allowMarkdown: true });
    expect(r.text).toBe(text);
    expect(rules(r)).not.toContain("markdown_emphasis");
  });
});

describe("voice linter: labelling meta and length target", () => {
  it("strips labelling meta-commentary", () => {
    const r = lintVoice("Bitkit Pay is planned, not shipped. Demo label is mine. Treat Pay as planned.");
    expect(r.text).not.toMatch(/Demo label is mine/i);
    expect(r.text).not.toMatch(/Treat Pay as planned/i);
    expect(rules(r)).toContain("labelling_meta");
  });

  it("records a soft length_target signal without rewriting", () => {
    const short = lintVoice("PKARR publishes keys as DNS packets.", { lengthTarget: { min: 600, max: 900 } });
    expect(short.text).toBe("PKARR publishes keys as DNS packets.");
    expect(rules(short)).toContain("length_target");
    const mid = "m".repeat(700);
    const ok = lintVoice(mid, { lengthTarget: { min: 600, max: 900 } });
    expect(ok.violations.filter((v) => v.rule === "length_target")).toHaveLength(0);
  });
});

describe("forbiddenHits (eval regexes)", () => {
  it("flags matches and reports invalid regexes", () => {
    const hits = forbiddenHits(
      "Great question! Here is the answer.",
      [
        { name: "opener_praise", pattern: "^\\s*(Great|Good) question" },
        { name: "ai_disclaimer", pattern: "\\bAs an AI\\b" },
        { name: "broken", pattern: "([unclosed" },
      ],
      "v000",
    );
    expect(hits.map((h) => h.rule)).toEqual(["opener_praise", "broken (invalid regex)"]);
    expect(hits.every((h) => h.item === "v000")).toBe(true);
  });
});
