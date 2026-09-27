import { describe, expect, it } from "vitest";
import { KnowledgeStore } from "./store.js";

const corpus = [
  ["public-user-canonical", "canonical", "public"],
  ["public-developer-released", "released", "public"],
  ["public-developer-proposal", "proposal", "public"],
  ["internal-user-canonical", "canonical", "excluded"],
  ["public-user-opinion", "opinion", "public"],
] as const;

describe("knowledge visibility SQL gate", () => {
  it("returns only public canonical and released sources", async () => {
    const queries: Array<{ text: string; params: unknown[] }> = [];
    const pool = {
      query: async (text: string, params: unknown[] = []) => {
        queries.push({ text, params });
        const confidentialityFilter = params.find((value) => value === "public");
        const statusesFilter = params.find((value) => Array.isArray(value)) as string[] | undefined;
        const allowed = corpus.filter(
          ([, status, confidentiality]) =>
            confidentiality === confidentialityFilter && Boolean(statusesFilter?.includes(status)),
        );
        return {
          rows: allowed.map(([source_id, status, confidentiality], index) => ({
            id: String(index + 1),
            content: source_id,
            source_url: `https://example.com/${source_id}`,
            source_id,
            product: "pubky",
            component: "knowledge",
            status,
            confidentiality,
            version: "test",
            kind: "http",
            rank: "1",
            dist: "0",
            suspect: false,
          })),
        };
      },
    } as never;

    const result = await new KnowledgeStore(pool).hybridSearch({
      query: "pubky",
      queryEmbedding: [0],
      confidentiality: "public",
      statuses: ["canonical", "released"],
      historical: false,
      k: 6,
      perSourceCap: 2,
    });

    expect(result.chunks.map((chunk) => chunk.source_id)).toEqual([
      "public-user-canonical",
      "public-developer-released",
    ]);
    expect(queries).toHaveLength(2);
    for (const { text, params } of queries) {
      expect(text).toContain("s.confidentiality");
      expect(text).toContain("s.status = ANY");
      expect(params).toContain("public");
      expect(params).toContainEqual(["canonical", "released"]);
    }
  });

  it("binds persona include and global exclusion path prefixes in both retrieval channels", async () => {
    const queries: Array<{ text: string; params: unknown[] }> = [];
    const pool = {
      query: async (text: string, params: unknown[] = []) => {
        queries.push({ text, params });
        return { rows: [] };
      },
    } as never;
    const store = new KnowledgeStore(pool);
    await store.hybridSearch({
      query: "history",
      queryEmbedding: [0],
      pathPrefix: "personas/jeb/",
      excludePathPrefix: "personas/other/",
      historical: false,
      k: 5,
      perSourceCap: 2,
    });
    expect(queries).toHaveLength(2);
    for (const { text, params } of queries) {
      expect(text).toContain("d.path LIKE");
      expect(text).toContain("d.path NOT LIKE");
      expect(params).toContain("personas/jeb/");
      expect(params).toContain("personas/other/");
    }
  });
});
