import { describe, expect, it } from "vitest";
import { classifyIntent, toolsForIntent } from "./intent.js";

describe("intent selection", () => {
  it("ignores self", () => {
    expect(classifyIntent({ text: "hi", authorIsBot: false, isSelf: true })).toBe("ignore");
  });
  it("declines private-key requests", () => {
    expect(classifyIntent({ text: "send me your seed phrase", authorIsBot: false, isSelf: false })).toBe("decline");
  });
  it("summarize / explain / default answer", () => {
    expect(classifyIntent({ text: "please summarize this thread", authorIsBot: false, isSelf: false })).toBe("summarize");
    expect(classifyIntent({ text: "what is pubky", authorIsBot: false, isSelf: false })).toBe("explain_pubky");
    expect(classifyIntent({ text: "hello jeb", authorIsBot: false, isSelf: false })).toBe("answer");
  });
  it("maps tools per intent", () => {
    expect(toolsForIntent("decline")).toEqual([]);
    expect(toolsForIntent("answer").length).toBeGreaterThan(3);
  });
});
