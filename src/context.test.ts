import { describe, expect, it } from "vitest";
import { ancestorsNewestFirst, assemblePrompt, type ChainPost } from "./context.js";

const p = (uri: string, createdAt: number, content = "c"): ChainPost => ({
  uri,
  createdAt,
  author: "a",
  name: "n",
  content,
});

describe("thread-order assembly", () => {
  it("orders ancestors by createdAt descending", () => {
    const ordered = ancestorsNewestFirst([p("old", 1), p("new", 3), p("mid", 2)]);
    expect(ordered.map((x) => x.uri)).toEqual(["new", "mid", "old"]);
  });

  it("prompt lists newest first and includes mention uri", () => {
    const mention = p("pubky://m", 9, "hello");
    const text = assemblePrompt("botpk", mention, [p("root", 1, "root"), mention]);
    const iNew = text.indexOf("[9]");
    const iOld = text.indexOf("[1]");
    expect(iNew).toBeGreaterThan(-1);
    expect(iOld).toBeGreaterThan(iNew);
    expect(text).toContain("Mention URI: pubky://m");
  });

  it("clips each post to 600 and the prompt body to 6000 (F-09)", () => {
    const mention = p("pubky://m", 9, "hello");
    const chain = Array.from({ length: 20 }, (_, i) => p(`u${i}`, i, "z".repeat(600)));
    const text = assemblePrompt("botpk", mention, chain);
    expect(text).not.toMatch(/z{601}/);
    const body = text.split("\n").filter((l) => l.includes(": z")).join("");
    const zs = (body.match(/z/g) ?? []).length;
    expect(zs).toBeLessThanOrEqual(6000);
  });

  it("marks the bot's own earlier turns as assistant for continuation", () => {
    const bot = "b".repeat(52);
    const mention = p("pubky://m", 9, "and then?");
    const botTurn = { ...p("pubky://b", 5, "my earlier answer"), author: bot };
    const userTurn = p("pubky://u", 3, "first question");
    const text = assemblePrompt(bot, mention, [userTurn, botTurn, mention]);
    expect(text).toContain(`assistant Jeb (${bot}): my earlier answer`);
    expect(text).toContain("user n (a): first question");
    expect(text).toContain("one conversation");
  });
});
