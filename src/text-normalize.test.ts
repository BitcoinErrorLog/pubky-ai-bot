import { describe, expect, it } from "vitest";
import { normalizeForScan } from "./text-normalize.js";

describe("normalizeForScan", () => {
  it("folds fullwidth digits and letters to ASCII", () => {
    expect(normalizeForScan("０１２３４５６７８９")).toBe("0123456789");
    expect(normalizeForScan("ａｂｃｄｅｆＡＢＣＤＥＦ")).toBe("abcdefABCDEF");
  });

  it("strips zero-width and other format characters", () => {
    expect(normalizeForScan("ab​cd‌ef‍g﻿h")).toBe("abcdefgh");
    expect(normalizeForScan("soft­hyphen")).toBe("softhyphen");
  });

  it("strips control characters but keeps tab/newline", () => {
    expect(normalizeForScan("ab\nc\td")).toBe("ab\nc\td");
  });

  it("preserves case and ordinary punctuation", () => {
    expect(normalizeForScan("Hello, World! 0xAbC")).toBe("Hello, World! 0xAbC");
  });

  it("decomposes compatibility characters (ligatures, circled digits)", () => {
    expect(normalizeForScan("ﬁle")).toBe("file");
    expect(normalizeForScan("①")).toBe("1");
  });
});
