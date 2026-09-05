import { describe, expect, it } from "vitest";
import { escapeHtml, renderDraftHtml } from "./render-html.js";

describe("draft HTML sanitizer", () => {
  it("escapes a hostile draft body so raw HTML never reaches the page", () => {
    const html = renderDraftHtml(`<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n[click](javascript:alert(1))\n**ok**`);
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toContain("<a href=\"javascript:");
    expect(html).toContain("<strong>ok</strong>");
  });

  it("keeps http(s) and pubky links after escaping", () => {
    const html = renderDraftHtml("[docs](https://pubky.org) and [post](pubky://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/pub/pubky.app/posts/AAAAAAAAAAAAA)");
    expect(html).toContain('href="https://pubky.org"');
    expect(html).toContain("pubky://");
    expect(html).toContain('rel="noreferrer noopener"');
  });

  it("escapeHtml encodes the five HTML specials", () => {
    expect(escapeHtml(`<&"'`)).toBe("&lt;&amp;&quot;&#39;");
  });
});
