import { describe, expect, it } from "vitest";
import { authorBlocked, botRepliesInChain, threadCapped, userHourCapped } from "./policy.js";

describe("policy", () => {
  it("skips self and blocklist", () => {
    expect(authorBlocked("bot", "bot", new Set())).toBe("self");
    expect(authorBlocked("evil", "bot", new Set(["evil"]))).toBe("blocklist");
    expect(authorBlocked("ok", "bot", new Set())).toBeNull();
  });

  it("enforces thread cap and hourly user cap", () => {
    expect(threadCapped(1, 1)).toBe(true);
    expect(threadCapped(0, 1)).toBe(false);
    expect(userHourCapped(5, 5)).toBe(true);
    expect(userHourCapped(4, 5)).toBe(false);
  });

  it("counts bot-authored posts in the ancestor chain (F4 / F-03)", () => {
    const bot = "b".repeat(52);
    expect(botRepliesInChain([{ author: bot }, { author: "u" }, { author: bot }], bot)).toBe(2);
    expect(threadCapped(botRepliesInChain([{ author: bot }], bot), 1)).toBe(true);
  });
});
