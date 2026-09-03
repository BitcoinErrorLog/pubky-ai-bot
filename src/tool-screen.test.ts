import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { InjectionDetector } from "./injection-detector.js";
import { screenToolResult, TOOL_RESULT_STRING_CAP } from "./tool-screen.js";

const injectedReadme = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../tests/knowledge/fixtures/injected/README.md"),
  "utf8",
);

describe("tool result screening (F-03)", () => {
  const detector = new InjectionDetector();

  it("passes a clean result through unchanged with no flags", () => {
    const value = { uri: "pubky://x", posts: [{ content: "credible exit is portable identity" }] };
    const r = screenToolResult(detector, value, { tool: "get_post" });
    expect(r.value).toEqual(value);
    expect(r.flags).toHaveLength(0);
  });

  it("sanitizes injected instruction patterns in nested string fields and flags them", () => {
    const value = {
      provenance: "scout",
      posts: [
        { uri: "pubky://a", content_preview: injectedReadme },
        { uri: "pubky://b", content_preview: "ordinary post text" },
      ],
    };
    const r = screenToolResult(detector, value, { tool: "search_posts" });
    expect(r.flags.length).toBeGreaterThanOrEqual(1);
    const flag = r.flags[0];
    expect(flag.tool).toBe("search_posts");
    expect(flag.path).toBe("posts[0].content_preview");
    expect(flag.patterns).toContain("instructionOverride");
    const screened = r.value as typeof value;
    expect(screened.posts[0].content_preview).not.toMatch(/\[SYSTEM\]/);
    expect(screened.posts[0].content_preview).toContain("[filtered]");
    expect(screened.posts[1].content_preview).toBe("ordinary post text");
  });

  it("screens knowledge chunk content (search_knowledge payload shape)", () => {
    const value = { chunks: [{ content: injectedReadme, source_url: "https://x", score: 0.5 }], truncated: false };
    const r = screenToolResult(detector, value, { tool: "search_knowledge" });
    expect(r.flags.some((f) => f.path === "chunks[0].content" && f.patterns.length > 0)).toBe(true);
  });

  it("caps over-long string fields and records the truncation", () => {
    const value = { bio: `hello ${"x".repeat(TOOL_RESULT_STRING_CAP + 100)}` };
    const r = screenToolResult(detector, value, { tool: "get_user" });
    expect(r.flags).toHaveLength(1);
    expect(r.flags[0].truncated).toBe(true);
    const screened = r.value as typeof value;
    expect(screened.bio.length).toBeLessThan(value.bio.length);
    expect(screened.bio).toMatch(/\[truncated\]$/);
  });

  it("leaves non-string fields and short id-like strings alone", () => {
    const value = { score: 0.9, ok: true, tags: ["bitcoin"], n: null };
    const r = screenToolResult(detector, value);
    expect(r.value).toEqual(value);
    expect(r.flags).toHaveLength(0);
  });
});
