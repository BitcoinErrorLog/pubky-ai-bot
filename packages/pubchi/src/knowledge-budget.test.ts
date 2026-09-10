import { describe, expect, it } from "vitest";
import { memoryPubchiKnowledgeBudget, postgresPubchiKnowledgeBudget } from "./knowledge-budget.js";

describe("Pubchi knowledge retrieval budget", () => {
  it("caps one owner at forty daily retrievals without affecting another owner", async () => {
    const budget = memoryPubchiKnowledgeBudget();
    for (let index = 0; index < 40; index += 1) expect(await budget.allow("owner-a")).toBe(true);
    expect(await budget.allow("owner-a")).toBe(false);
    expect(await budget.allow("owner-b")).toBe(true);
  });

  it("uses the owner-keyed scout counter in Postgres", async () => {
    const calls: Array<{ sql: string; values?: unknown[] }> = [];
    const budget = postgresPubchiKnowledgeBudget({
      query: async (sql, values) => {
        calls.push({ sql, values });
        return { rows: calls.length === 1 ? [{ n: "39" }] : [] };
      },
    });
    expect(await budget.allow("owner-a")).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.values?.[0]).toBe("knowledge_search");
    expect(calls[1]?.values?.[0]).toBe("knowledge_search");
  });
});
