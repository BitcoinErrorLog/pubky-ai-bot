import { describe, expect, it } from "vitest";
import { ConversationalPlan, TOOL_OUTPUT_MANIFESTS } from "./conversational-plan.js";

const scope = {
  window: { since_ms: 1, until_ms: 2, source: "default" as const, label: "last day" },
  graph: { kind: "whole_graph" as const },
};

describe("ConversationalPlan", () => {
  it.each([
    {
      kind: "template",
      tool: "rank_users",
      params: { metric: "followers" },
      scope,
    },
    {
      kind: "cypher",
      query: "MATCH (u:User) RETURN u.id LIMIT 1",
      params: {},
      rationale: "read-only lookup",
      scope,
    },
    { kind: "answer", text: "I can answer questions about the indexed graph.", reason: "conversational" },
    { kind: "feed", spec: { name: "Bitcoin", icon: "bitcoin", feed: { reach: "all", sort: "recent", layout: "columns" } } },
  ] as const)("parses a %s plan", (plan) => {
    expect(ConversationalPlan.safeParse(plan).success).toBe(true);
  });

  it("parses a backward chain using a declared manifest path", () => {
    const parsed = ConversationalPlan.safeParse({
      kind: "chain",
      steps: [
        { id: "s1", action: { kind: "template", tool: "rank_users", params: { metric: "followers" }, scope } },
        {
          id: "s2",
          action: {
            kind: "template",
            tool: "get_user",
            params: { pubky: { from_step: "s1", path: "users[0].pubky" } },
            scope,
          },
        },
      ],
      scope,
    });
    expect(parsed.success).toBe(true);
  });

  it.each([
    {
      kind: "chain",
      steps: [
        { id: "s1", action: { kind: "template", tool: "rank_users", params: {}, scope } },
        { id: "s2", action: { kind: "template", tool: "get_user", params: { pubky: { from_step: "s3", path: "users[0].pubky" } }, scope } },
        { id: "s3", action: { kind: "template", tool: "get_user", params: {}, scope } },
      ],
      scope,
    },
    {
      kind: "chain",
      steps: [
        { id: "s1", action: { kind: "template", tool: "get_relationship", params: {}, scope } },
        { id: "s2", action: { kind: "template", tool: "get_user", params: { pubky: { from_step: "s1", path: "users[0].pubky" } }, scope } },
      ],
      scope,
    },
    {
      kind: "template",
      tool: "rank_users",
      params: { owner: "not-model-supplied" },
      scope,
    },
    {
      kind: "template",
      tool: "not-a-tool",
      params: {},
      scope,
    },
    {
      kind: "chain",
      steps: [
        { id: "s1", action: { kind: "template", tool: "rank_users", params: {}, scope } },
        { id: "s2", action: { kind: "template", tool: "get_user", params: { pubky: { from_step: "s1", path: "topics[0].label" } }, scope } },
        { id: "s3", action: { kind: "template", tool: "get_user", params: {}, scope } },
        { id: "s4", action: { kind: "template", tool: "get_user", params: {}, scope } },
      ],
      scope,
    },
  ])("rejects unsafe plan %#", (plan) => {
    expect(ConversationalPlan.safeParse(plan).success).toBe(false);
  });

  it("does not grant undeclared output paths", () => {
    expect(TOOL_OUTPUT_MANIFESTS.get_relationship).toEqual([]);
    expect(TOOL_OUTPUT_MANIFESTS.rank_users).toContain("users[0].pubky");
  });

  it("rejects value nesting deeper than three levels", () => {
    const nested = { a: { b: { c: { d: "too deep" } } } };
    expect(ConversationalPlan.safeParse({
      kind: "template",
      tool: "rank_users",
      params: nested,
      scope,
    }).success).toBe(false);
  });

  it("rejects serialized params larger than four KiB", () => {
    expect(ConversationalPlan.safeParse({
      kind: "template",
      tool: "rank_users",
      params: { value: "x".repeat(4090) },
      scope,
    }).success).toBe(false);
  });
});
