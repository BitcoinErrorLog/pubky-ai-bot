import { describe, expect, it } from "vitest";
import { composeReply } from "./compose.js";
import { parseModes } from "./modes.js";

describe("modes and composition", () => {
  it("parses short/deep/sources", () => {
    expect([...parseModes("give me a deep answer with sources")]).toEqual(expect.arrayContaining(["deep", "sources"]));
    expect(parseModes("tldr please").has("short")).toBe(true);
  });
  it("caps short replies at 2000 and deep at 50000", () => {
    const short = composeReply("a".repeat(3000), parseModes("short"), []);
    expect(short.content).toHaveLength(2000);
    expect(short.long).toBe(false);
    const deep = composeReply("b".repeat(3000), parseModes("deep"), []);
    expect(deep.long).toBe(true);
    expect(deep.content).toHaveLength(3000);
  });
});
