import { describe, expect, it } from "vitest";
import { parseRankingScope, parseRankingWindow } from "./planner.js";
import { rankUsersTemplate } from "../scout/templates.js";

const NOW = 1_700_000_000_000;

describe("ranking window parsing", () => {
  it.each([
    ["this week", 7],
    ["today", 1],
    ["this month", 30],
    ["last 30 days", 30],
    ["unspecified", 30],
  ])("%s uses %s days", (phrase, days) => {
    const window = parseRankingWindow(phrase, NOW);
    expect(window).toEqual({ since: NOW - days * 24 * 60 * 60 * 1000, until: NOW });
  });

  it("uses no since bound for all-time questions", () => {
    expect(parseRankingWindow("who has the most tags ever", NOW)).toBe("all_time");
  });

  it("classifies network and graph scope", () => {
    expect(parseRankingScope("most tagged users in my network")).toBe("network");
    expect(parseRankingScope("most tagged users")).toBe("graph");
  });

  it("passes the plan-time millisecond window to the Scout template unchanged", () => {
    const window = parseRankingWindow("this week", NOW);
    if (window === "all_time") throw new Error("expected bounded window");
    const query = rankUsersTemplate({ metric: "tags_received", order: "desc", time: window, limit: 10 });
    expect(query.params).toMatchObject({ since: window.since, until: window.until });
    expect(query.cypher).toContain("$since");
    expect(window.since).toBeGreaterThan(1_000_000_000_000);
  });

  it("restricts network rankings to the asker's graph", () => {
    const query = rankUsersTemplate({
      metric: "followers",
      order: "desc",
      time: { since: 0, until: NOW },
      graphScope: { pubky: "owner" },
      limit: 10,
    });
    expect(query.params).toMatchObject({ scope_id: "owner" });
    expect(query.cypher).toContain("$scope_id");
  });
});
