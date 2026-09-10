import { describe, expect, it } from "vitest";
import { discoverPubkyLinks } from "./resource-links.js";
import { DiscoveryRequestBudget } from "./resource-posts.js";
import type { PostView } from "./types.js";

const AUTHOR = "gujx6qd8ksydh1makdphd3bxu351d9b8waqka8hfg6q7hnqkxexo";
const NOW = new Date(1_700_000_900_001);

function post(content: string, id = "00335K18AMRRG", extra: Partial<PostView["details"]> = {}): PostView {
  return {
    details: {
      content,
      id,
      indexed_at: 1_700_000_000_000,
      created_at: 1_700_000_000_000,
      author: AUTHOR,
      kind: "long",
      uri: `pubky://${AUTHOR}/pub/pubky.app/posts/${id}`,
      ...extra,
    },
    counts: { replies: 10, reposts: 2, tags: 4 },
    tags: [{ label: "bitcoin", taggers: ["other"] }],
    relationships: {},
  };
}

function options(posts: PostView[], extra: Record<string, unknown> = {}) {
  let calls = 0;
  return {
    nexus: {
      streamPosts: async () => calls++ === 0 ? posts : [],
      hotTags: async () => [],
    } as never,
    limit: 40,
    now: NOW,
    publisherPk: AUTHOR,
    authorCreatedAtMs: async () => 1_600_000_000_000,
    fetchPage: async () => ({
      ok: true as const,
      text: "A real page body",
      title: "A page",
      description: "A description",
      authors: [],
      finalUrl: "https://example.com/",
      bytes: 100,
      truncated: false,
      fromCache: false,
    }),
    ...extra,
  };
}

describe("Pubky links resource adapter", () => {
  it("extracts content URLs and accepts homepages", async () => {
    const result = await discoverPubkyLinks(options([post("Read https://example.com/")]));
    expect(result.accepted[0]?.canonicalValue).toBe("https://example.com/");
    expect(result.bySharingPost["https://example.com/"]).toEqual([expect.stringContaining("/posts/")]);
  });

  it("extracts attachments and rejects Pubky URLs", async () => {
    const result = await discoverPubkyLinks(options([
      post("See this", "00335K18AMRRG", { attachments: ["pubky://abc", "https://example.org/article"] }),
    ]));
    expect(result.accepted.map((item) => item.canonicalValue)).toEqual(["https://example.org/article"]);
    expect(result.linkRejections["pubky-url"]).toBe(1);
  });

  it("deduplicates a URL across posts and keeps every sharing URI", async () => {
    const result = await discoverPubkyLinks(options([
      post("https://example.com/", "00335K18AMRRG"),
      post("https://example.com/", "00335K18AMRRS"),
    ]));
    expect(result.accepted).toHaveLength(1);
    expect(result.bySharingPost["https://example.com/"]).toHaveLength(2);
    expect(result.accepted[0]?.provenance.scoreComponents?.pubky_signal).toBeGreaterThan(0);
  });

  it("skips links already tagged by the publisher", async () => {
    const result = await discoverPubkyLinks(options([post("https://already.example/")], {
      alreadyJebTagged: async () => true,
    }));
    expect(result.accepted).toHaveLength(0);
    expect(result.linkRejections["already-jeb-tagged"]).toBe(1);
  });

  it("accepts a shortener only when the guarded fetch resolves it", async () => {
    const result = await discoverPubkyLinks(options([post("https://short.example/x")], {
      fetchPage: async () => ({
        ok: true as const,
        text: "resolved page",
        title: "Resolved",
        finalUrl: "https://example.com/real",
        bytes: 10,
        truncated: false,
        fromCache: false,
      }),
    }));
    expect(result.accepted[0]?.canonicalValue).toBe("https://short.example/x");
  });

  it("counts guarded-fetch failures for binary content", async () => {
    const result = await discoverPubkyLinks(options([post("https://binary.example/file")], {
      fetchPage: async () => ({ ok: false as const, reason: "content_type" as const }),
    }));
    expect(result.accepted).toHaveLength(0);
    expect(result.linkRejections.content_type).toBe(1);
  });

  it("records shared discovery budget exhaustion", async () => {
    const budget = new DiscoveryRequestBudget(1);
    budget.used = budget.ceiling;
    const result = await discoverPubkyLinks({
      ...options([]),
      limit: 1,
      requestBudget: budget,
      nexus: {
        streamPosts: async () => [],
        hotTags: async () => Array.from({ length: 20 }, (_, index) => `tag-${index}`),
      } as never,
    });
    expect(result.postRejections["discovery-request-budget"]).toBeGreaterThan(0);
  });

  it("records prompt context and excludes publisher-only post tags", async () => {
    const result = await discoverPubkyLinks(options([{
      ...post("Shared https://example.com/"),
      tags: [{ label: "publisher-only", taggers: [AUTHOR] }, { label: "human", taggers: ["other"] }],
    }]));
    expect(result.accepted[0]?.tagHints).toEqual(["human"]);
    expect(result.accepted[0]?.metadata).toEqual({ sharedPostText: "Shared https://example.com/" });
  });

  it("bounds large link batches and keeps deterministic top candidates", async () => {
    const urls = Array.from({ length: 150 }, (_, index) => `https://example-${String(index).padStart(3, "0")}.example/`);
    const result = await discoverPubkyLinks({
      ...options([post(urls.join(" "))]),
      limit: 100,
    });
    expect(result.accepted).toHaveLength(100);
    expect(Object.keys(result.bySharingPost).sort()).toEqual(
      result.accepted.map((item) => item.canonicalValue).sort(),
    );
  });

  it("retains equal-priority links by canonical URL rather than arrival order", async () => {
    const urls = Array.from({ length: 100 }, (_, index) => `https://tie-${String(index).padStart(3, "0")}.example/`);
    const result = await discoverPubkyLinks({
      ...options([post("Attached links", "00335K18AMRRG", { attachments: urls.slice().reverse() })]),
      limit: 100,
    });
    expect(result.accepted.map((item) => item.canonicalValue)).toEqual(urls.slice().sort());
  });

  it("caps links by registrable domain before the global record cap", async () => {
    const urls = [
      ...Array.from({ length: 70 }, (_, index) => {
        const hosts = ["saturating.example.com", "www.saturating.example.com", "a.saturating.example.com", "b.saturating.example.com"];
        return `https://${hosts[index % hosts.length]}/${index}`;
      }),
      ...Array.from({ length: 50 }, (_, index) => `https://other-${index}.com/${index}`),
    ];
    const result = await discoverPubkyLinks({ ...options([post(urls.join(" "))]), limit: 100 });
    const saturating = result.accepted.filter((item) => item.canonicalValue.includes("saturating.example.com"));
    expect(saturating).toHaveLength(20);
    expect(result.accepted).toHaveLength(70);
    expect(result.linkRejections["host-quota"]).toBeGreaterThan(0);
  });

  it("checks each rejected URL only once per run", async () => {
    let checks = 0;
    const result = await discoverPubkyLinks(options(
      Array.from({ length: 20 }, (_, index) => post("https://tagged.example/", `00335K18AMR${String(index).padStart(2, "0")}`)),
      { alreadyJebTagged: async () => { checks += 1; return true; } },
    ));
    expect(checks).toBe(1);
    expect(result.linkRejections["already-jeb-tagged"]).toBe(1);
  });

  it("continues when Nexus tag checks fail", async () => {
    const result = await discoverPubkyLinks(options([post("https://nexus-down.example/")], {
      alreadyJebTagged: async () => { throw new Error("500"); },
    }));
    expect(result.accepted).toHaveLength(0);
    expect(result.linkRejections["nexus-unavailable"]).toBe(1);
  });
});
