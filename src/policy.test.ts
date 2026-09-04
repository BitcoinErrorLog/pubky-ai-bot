import { describe, expect, it } from "vitest";
import {
  SKIP_REASONS,
  SILENT_SKIPS,
  NOTIFIED_SKIPS,
  isNotifiedSkip,
  isSilentSkip,
  authorBlocked,
  botLoopInChain,
  botRepliesInChain,
  conversationDecision,
  declaredAutomation,
  isAddressedTurn,
  jebTurnsWithAsker,
  replierIsAutomated,
  threadCapped,
  userHourCapped,
  userTurnCapped,
} from "./policy.js";

const BOT = "b".repeat(52);
const USER = "u".repeat(52);
const USER2 = "v".repeat(52);
const OTHER_BOT = "k".repeat(52);

describe("policy", () => {
  it("enumerates skip reasons", () => {
    expect([...SKIP_REASONS]).toEqual([
      "thread_cap",
      "user_turn_cap",
      "user_hourly_cap",
      "bot_author",
      "bot_loop",
      "unaddressed",
      "blocklist",
      "budget",
      "optout",
    ]);
    expect([...SILENT_SKIPS]).toEqual(["blocklist", "bot_author", "unaddressed", "bot_loop", "self", "optout"]);
    expect([...NOTIFIED_SKIPS]).toEqual(["budget", "user_hourly_cap", "user_turn_cap", "thread_cap"]);
    expect(isNotifiedSkip("budget")).toBe(true);
    expect(isNotifiedSkip("blocklist")).toBe(false);
    expect(isSilentSkip("self")).toBe(true);
    expect(isSilentSkip("budget")).toBe(false);
  });

  it("skips self and blocklist", () => {
    expect(authorBlocked("bot", "bot", new Set())).toBe("self");
    expect(authorBlocked("evil", "bot", new Set(["evil"]))).toBe("blocklist");
    expect(authorBlocked("ok", "bot", new Set())).toBeNull();
  });

  it("enforces thread cap and hourly user cap", () => {
    expect(threadCapped(12, 12)).toBe(true);
    expect(threadCapped(11, 12)).toBe(false);
    expect(userHourCapped(5, 5)).toBe(true);
    expect(userHourCapped(4, 5)).toBe(false);
    expect(userTurnCapped(6, 6)).toBe(true);
    expect(userTurnCapped(5, 6)).toBe(false);
  });

  it("counts bot-authored posts in the ancestor chain (F4 / F-03)", () => {
    expect(botRepliesInChain([{ author: BOT }, { author: "u" }, { author: BOT }], BOT)).toBe(2);
    expect(threadCapped(botRepliesInChain([{ author: BOT }], BOT), 1)).toBe(true);
  });

  it("counts Jeb turns with a given asker, not every Jeb post in the thread", () => {
    const chain = [
      { author: USER2 },
      { author: BOT },
      { author: USER },
      { author: BOT },
      { author: USER },
    ];
    expect(jebTurnsWithAsker(chain, BOT, USER)).toBe(2);
    expect(jebTurnsWithAsker(chain, BOT, USER2)).toBe(0);
    expect(jebTurnsWithAsker([{ author: BOT }, { author: USER2 }], BOT, USER2)).toBe(1);
  });

  it("treats an explicit mention or a reply to Jeb as a conversation turn", () => {
    expect(
      isAddressedTurn({
        botPk: BOT,
        content: `hey pubky${BOT}`,
        mentioned: [BOT],
        parentUri: `pubky://${USER}/pub/pubky.app/posts/AAAAAAAAAAAAA`,
      }),
    ).toBe(true);
    expect(
      isAddressedTurn({
        botPk: BOT,
        content: "and what about ring?",
        mentioned: [],
        parentUri: `pubky://${BOT}/pub/pubky.app/posts/0000000000BOT`,
      }),
    ).toBe(true);
    expect(isAddressedTurn({ botPk: BOT, content: "hi", mentioned: [], parentUri: null })).toBe(true);
    expect(
      isAddressedTurn({
        botPk: BOT,
        content: "side chat",
        mentioned: [],
        parentUri: `pubky://${USER}/pub/pubky.app/posts/AAAAAAAAAAAAA`,
      }),
    ).toBe(false);
  });

  it("detects Jeb→Jeb and a run of three bot-authored posts", () => {
    const isBot = (pk: string) => pk === OTHER_BOT;
    expect(botLoopInChain([{ author: USER }, { author: BOT }, { author: USER }], BOT, isBot)).toBe(false);
    expect(botLoopInChain([{ author: USER }, { author: BOT }, { author: BOT }], BOT, isBot)).toBe(true);
    expect(
      botLoopInChain([{ author: USER }, { author: OTHER_BOT }, { author: OTHER_BOT }, { author: BOT }], BOT, isBot),
    ).toBe(true);
  });

  it("detects profiles that declare automation", () => {
    expect(declaredAutomation({ name: "Feed Bot", bio: null })).toBe(true);
    expect(declaredAutomation({ name: "n", bio: "I am an automated account run by Example" })).toBe(true);
    expect(declaredAutomation({ name: "n", bio: "auto-poster of links" })).toBe(true);
    expect(declaredAutomation({ name: "Alice", bio: "human, mostly" })).toBe(false);
    expect(declaredAutomation(null)).toBe(false);
    expect(declaredAutomation({ name: "OtherBot", bio: "" })).toBe(false);
  });

  it("flags repliers via JEB_KNOWN_BOTS or declared automation", () => {
    const known = new Set([OTHER_BOT]);
    expect(replierIsAutomated(OTHER_BOT, null, known)).toBe(true);
    expect(replierIsAutomated(USER, { name: "Relay bot", bio: null }, new Set())).toBe(true);
    expect(replierIsAutomated(USER, { name: "Uma", bio: null }, known)).toBe(false);
    expect(replierIsAutomated(USER, null, undefined)).toBe(false);
  });
});

describe("conversationDecision skip reasons", () => {
  const ok = {
    addressed: true,
    automatedReplier: false,
    botLoop: false,
    jebRepliesInThread: 1,
    maxRepliesPerThread: 12,
    jebTurnsWithAsker: 1,
    maxTurnsPerUserPerThread: 6,
    userHourCount: 0,
    maxPerUserPerHour: 5,
    budgetExceeded: false,
    blocklisted: false,
  };

  it("answers an addressed follow-up after one Jeb reply", () => {
    expect(conversationDecision(ok)).toBeNull();
  });

  it("answers a second user's addressed turn in the same thread", () => {
    expect(conversationDecision({ ...ok, jebTurnsWithAsker: 0, jebRepliesInThread: 1 })).toBeNull();
  });

  it("skips thread_cap", () => {
    expect(conversationDecision({ ...ok, jebRepliesInThread: 12 })).toBe("thread_cap");
  });

  it("skips user_turn_cap on the 7th turn", () => {
    expect(conversationDecision({ ...ok, jebTurnsWithAsker: 6 })).toBe("user_turn_cap");
  });

  it("skips user_hourly_cap", () => {
    expect(conversationDecision({ ...ok, userHourCount: 5 })).toBe("user_hourly_cap");
  });

  it("skips bot_author", () => {
    expect(conversationDecision({ ...ok, automatedReplier: true })).toBe("bot_author");
  });

  it("skips bot_loop", () => {
    expect(conversationDecision({ ...ok, botLoop: true })).toBe("bot_loop");
  });

  it("skips unaddressed", () => {
    expect(conversationDecision({ ...ok, addressed: false })).toBe("unaddressed");
  });

  it("skips blocklist", () => {
    expect(conversationDecision({ ...ok, blocklisted: true })).toBe("blocklist");
  });

  it("skips budget", () => {
    expect(conversationDecision({ ...ok, budgetExceeded: true })).toBe("budget");
  });

  it("skips optout silently (before caps)", () => {
    expect(conversationDecision({ ...ok, optedOut: true, jebRepliesInThread: 12 })).toBe("optout");
    expect(isSilentSkip("optout")).toBe(true);
    expect(isNotifiedSkip("optout")).toBe(false);
  });
});
