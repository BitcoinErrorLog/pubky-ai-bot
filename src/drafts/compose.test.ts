import { describe, expect, it } from "vitest";
import { composeDraftProse } from "./compose.js";
import { DraftRejectedError, dropIncompleteTail, isLinkOnlyBody } from "./finish.js";
import {
  fetchGithubCommitsSince,
  fetchGithubJson,
  githubApiRedirectTarget,
  githubHeaders,
  githubRateLimited,
  GithubUnavailableError,
} from "./github.js";
import { generateWhatChanged } from "./what-changed.js";

const DOC = "https://pubky.org/Explore/Concepts/Homeserver.md";
const COMMIT = "https://github.com/pubky/pubky-core/commit/abc123";
const RELEASE = "https://github.com/pubky/pubky-core/releases/tag/v0.9.0";

const CLEAN = [
  `- Homeserver docs changed: session expiry is now explicit in the public index. ${DOC}`,
  `- pubky-core commit: tighter idle expiry on session tokens. ${COMMIT}`,
  `- pubky-core v0.9.0: the session API is what callers should read. ${RELEASE}`,
].join("\n");

describe("dropIncompleteTail", () => {
  it("drops a cut-off bullet and keeps the complete ones", () => {
    const raw = [
      `- Homeserver docs changed: session expiry is now explicit. ${DOC}`,
      `- pubky-core commit: tighter expiry. ${COMMIT}`,
      `- Nexus ops changed: the db clear command`,
    ].join("\n");
    const kept = dropIncompleteTail(raw);
    expect(kept).toContain("session expiry");
    expect(kept).toContain("tighter expiry");
    expect(kept).not.toContain("db clear command");
  });
});

describe("isLinkOnlyBody", () => {
  it("flags a markdown-link-only answer", () => {
    expect(isLinkOnlyBody(`[What moved in Pubky repos this window (my](${DOC})`)).toBe(true);
    expect(isLinkOnlyBody(DOC)).toBe(true);
    expect(isLinkOnlyBody(CLEAN)).toBe(false);
  });
});

describe("composeDraftProse quality", () => {
  it("accepts a clean body", async () => {
    const text = await composeDraftProse({
      format: "what_changed",
      instruction: "write bullets",
      evidenceNotes: DOC,
      noneFallback: "thin",
      complete: async () => CLEAN,
    });
    expect(text).toContain("session expiry");
    expect(text).toContain(DOC);
  });

  it("drops a length-stop cut-off bullet and keeps two complete ones", async () => {
    const text = await composeDraftProse({
      format: "what_changed",
      instruction: "write bullets",
      evidenceNotes: `${DOC}\n${COMMIT}`,
      noneFallback: "thin",
      complete: async () => ({
        finishReason: "length",
        text: [
          `- Homeserver docs changed: session expiry is now explicit. ${DOC}`,
          `- pubky-core commit: tighter idle expiry on session tokens. ${COMMIT}`,
          `- Nexus ops changed: the db clear command`,
        ].join("\n"),
      }),
    });
    expect(text).toContain("tighter idle expiry");
    expect(text).not.toContain("db clear command");
  });

  it("returns none: truncated output when a length-stop leaves fewer than two bullets", async () => {
    await expect(
      composeDraftProse({
        format: "what_changed",
        instruction: "write bullets",
        evidenceNotes: DOC,
        noneFallback: "thin",
        complete: async () => ({
          finishReason: "length",
          text: `- Homeserver docs changed: session expiry.\n- Nexus ops changed: the db clear command`,
        }),
      }),
    ).rejects.toThrow(/none: truncated output/);
  });

  it("retries a link-only body once, then none", async () => {
    let n = 0;
    await expect(
      composeDraftProse({
        format: "what_changed",
        instruction: "write bullets",
        evidenceNotes: DOC,
        noneFallback: "thin",
        complete: async () => {
          n += 1;
          return `[What moved in Pubky repos this window (my](${DOC})`;
        },
      }),
    ).rejects.toThrow(/none: link-only body/);
    expect(n).toBe(2);
  });

  it("accepts a clean body on the link-only retry", async () => {
    let n = 0;
    const text = await composeDraftProse({
      format: "what_changed",
      instruction: "write bullets",
      evidenceNotes: `${DOC}\n${COMMIT}\n${RELEASE}`,
      noneFallback: "thin",
      complete: async () => {
        n += 1;
        if (n === 1) return `[What moved](${DOC})`;
        return CLEAN;
      },
    });
    expect(n).toBe(2);
    expect(text).toContain("session expiry");
  });
});

describe("githubHeaders", () => {
  it("uses only JEB_GITHUB_TOKEN, never GITHUB_TOKEN or GH_TOKEN", () => {
    const dedicated = "jeb-gh-readonly-token";
    expect(githubHeaders({ JEB_GITHUB_TOKEN: dedicated }).Authorization).toBe(`Bearer ${dedicated}`);
    expect(githubHeaders({ GITHUB_TOKEN: "ghp_unrelated", GH_TOKEN: "gho_unrelated" }).Authorization).toBeUndefined();
    expect(
      githubHeaders({
        JEB_GITHUB_TOKEN: dedicated,
        GITHUB_TOKEN: "ghp_unrelated",
        GH_TOKEN: "gho_unrelated",
      }).Authorization,
    ).toBe(`Bearer ${dedicated}`);
    expect(githubHeaders({}).Authorization).toBeUndefined();
  });
});

describe("githubRateLimited", () => {
  it("detects 403, 429, and remaining 0", () => {
    const h = (v: string | null) => ({ get: (n: string) => (n.toLowerCase() === "x-ratelimit-remaining" ? v : null) });
    expect(githubRateLimited(403, h("10"))).toBe(true);
    expect(githubRateLimited(429, h("10"))).toBe(true);
    expect(githubRateLimited(200, h("0"))).toBe(true);
    expect(githubRateLimited(200, h("12"))).toBe(false);
  });
});

describe("githubApiRedirectTarget", () => {
  it("allows same-host repository id redirects and rejects off-host", () => {
    const from = new URL("https://api.github.com/repos/pubky/pubky-core/commits");
    const ok = githubApiRedirectTarget(from, "https://api.github.com/repositories/728735154/commits");
    expect(ok?.pathname).toBe("/repositories/728735154/commits");
    expect(githubApiRedirectTarget(from, "https://evil.example/x")).toBeNull();
  });
});

describe("fetchGithubCommitsSince redirects", () => {
  it("follows a same-host 301 and parses commits", async () => {
    const orig = globalThis.fetch;
    const payload = [
      {
        sha: "abc123",
        html_url: "https://github.com/pubky/pubky-core/commit/abc123",
        commit: { message: "session expiry", author: { date: "2026-09-04T00:00:00Z" } },
      },
    ];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const href = String(input);
      if (href.includes("/repos/")) {
        return new Response(null, {
          status: 301,
          headers: { location: "https://api.github.com/repositories/1/commits", "x-ratelimit-remaining": "9" },
        });
      }
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json", "x-ratelimit-remaining": "9" },
      });
    }) as typeof fetch;
    try {
      const rows = await fetchGithubCommitsSince("pubky", "pubky-core", "2026-09-01T00:00:00Z", 5_000);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.message).toBe("session expiry");
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("throws GithubUnavailableError when the API is rate-limited", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } })) as typeof fetch;
    try {
      await expect(fetchGithubCommitsSince("pubky", "pubky-core", "2026-09-01T00:00:00Z", 5_000)).rejects.toBeInstanceOf(
        GithubUnavailableError,
      );
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe("github response size cap", () => {
  it("aborts when the streamed body exceeds 1MB", async () => {
    const orig = globalThis.fetch;
    const chunk = new Uint8Array(600_000).fill(97);
    globalThis.fetch = (async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(chunk);
          controller.enqueue(chunk);
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "application/json", "x-ratelimit-remaining": "9" },
      });
    }) as typeof fetch;
    try {
      await expect(fetchGithubJson(new URL("https://api.github.com/repos/pubky/pubky-core/commits"), 5_000)).rejects.toThrow(
        /too large/,
      );
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe("what_changed evidence unavailable", () => {
  it("returns none: evidence source unavailable when GitHub is rate-limited", async () => {
    await expect(
      generateWhatChanged({
        nowMs: Date.parse("2026-09-05T12:00:00Z"),
        listKnowledgeChanges: async () => [],
        listCommits: async () => {
          throw new GithubUnavailableError();
        },
        listReleases: async () => [],
        complete: async () => CLEAN,
      }),
    ).rejects.toBeInstanceOf(DraftRejectedError);
    await expect(
      generateWhatChanged({
        nowMs: Date.parse("2026-09-05T12:00:00Z"),
        listKnowledgeChanges: async () => [],
        listCommits: async () => {
          throw new GithubUnavailableError();
        },
        listReleases: async () => [],
        complete: async () => CLEAN,
      }),
    ).rejects.toThrow(/none: evidence source unavailable/);
  });
});
