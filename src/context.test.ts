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
});
