import { describe, expect, it } from "vitest";
import { dropUnknownCitations, normalizeHref } from "./citations.js";
import { isPubkyEcosystemRepo, isPubkyEcosystemSlug } from "./ecosystem.js";
import { DraftRejectedError } from "./finish.js";
import { generateNewConnection } from "./new-connection.js";
import { generatePubkyExplained } from "./pubky-explained.js";
import { generateReleaseRadar } from "./release-radar.js";
import { generateTheDisagreement } from "./the-disagreement.js";
import { generateThreadWorthReading } from "./thread-worth-reading.js";
import type { ThreadPost } from "./thread.js";
import { generateWhatChanged } from "./what-changed.js";
import type { ScoutTools } from "./scout-util.js";
import { encodePostIdMs } from "./window.js";

const APP = "https://pubky.app";
const NOW = Date.parse("2026-09-05T12:00:00Z");
const USER = "1111111111111111111111111111111111111111111111111111";
const USERB = "2222222222222222222222222222222222222222222222222222";
const EVIL = "https://evil.example/phish";

function idAt(ms: number): string {
  return encodePostIdMs(ms);
}

function postHref(author: string, postId: string): string {
  return `${APP}/post/${author}/${postId}`;
}

function profileHref(author: string): string {
  return `${APP}/profile/${author}`;
}

function seedPost(author: string, postId: string, content: string, indexedAt: number) {
  return {
    uri: `pubky://${author}/pub/pubky.app/posts/${postId}`,
    author_id: author,
    post_id: postId,
    content,
    content_preview: content,
    indexed_at: indexedAt,
  };
}

function threadPosts(opts: {
  rootMs: number;
  replyMs: number;
  rootContent: string;
  replyContent: string;
  replyAuthor?: string;
}): ThreadPost[] {
  const rootId = idAt(opts.rootMs);
  const replyId = idAt(opts.replyMs);
  const replyAuthor = opts.replyAuthor ?? USERB;
  const rootUri = `pubky://${USER}/pub/pubky.app/posts/${rootId}`;
  return [
    {
      uri: rootUri,
      author_id: USER,
      post_id: rootId,
      content: opts.rootContent,
      indexed_at: opts.rootMs,
      tags: ["pubky"],
      parent_uri: null,
    },
    {
      uri: `pubky://${replyAuthor}/pub/pubky.app/posts/${replyId}`,
      author_id: replyAuthor,
      post_id: replyId,
      content: opts.replyContent,
      indexed_at: opts.replyMs,
      tags: ["homeserver"],
      parent_uri: rootUri,
    },
  ];
}

function scoutTop(posts: ReturnType<typeof seedPost>[]): ScoutTools {
  return {
    top_posts: { execute: async () => ({ posts }) },
  } as unknown as ScoutTools;
}

function noneComplete() {
  return async () => "none\ntrivial input";
}

describe("ecosystem allowlist", () => {
  it("keeps pubky/* and named repos, drops bitkit", () => {
    expect(isPubkyEcosystemRepo("pubky", "anything")).toBe(true);
    expect(isPubkyEcosystemRepo("synonymdev", "pubky-core")).toBe(true);
    expect(isPubkyEcosystemRepo("synonymdev", "bitkit-core")).toBe(false);
    expect(isPubkyEcosystemSlug("synonymdev/bitkit-android")).toBe(false);
    expect(isPubkyEcosystemSlug("pubky/pubky-nexus")).toBe(true);
  });
});

describe("dropUnknownCitations", () => {
  const allowed = new Set([normalizeHref(postHref(USER, "0035N00000000"))]);

  it("drops a bullet that cites a URL outside the evidence set", () => {
    const body = [
      "A paragraph with no link.",
      `- good ${postHref(USER, "0035N00000000")}`,
      `- bad ${EVIL}`,
    ].join("\n");
    const out = dropUnknownCitations(body, allowed);
    expect(out).toContain("good");
    expect(out).not.toContain("evil.example");
    expect(out).toContain("A paragraph with no link.");
  });
});

describe("thread_worth_reading", () => {
  const rootMs = NOW - 2 * 86400000;
  const replyMs = NOW - 1 * 86400000;
  const posts = threadPosts({
    rootMs,
    replyMs,
    rootContent: "Homeservers should expire idle sessions.",
    replyContent: "Idle timeout is the wrong lever; rotate keys instead.",
  });
  const rootHref = postHref(USER, posts[0]!.post_id);
  const replyHref = postHref(USERB, posts[1]!.post_id);

  it("(a) writes a well-formed draft from a multi-author thread", async () => {
    const d = await generateThreadWorthReading({
      scout: scoutTop([seedPost(USER, posts[0]!.post_id, posts[0]!.content, rootMs)]),
      appUrl: APP,
      nowMs: NOW,
      fetchThread: async () => posts,
      complete: async () =>
        [
          `This thread is about session lifetime on homeservers.`,
          `- ${profileHref(USER)} argues idle expiry. ${rootHref}`,
          `- ${profileHref(USERB)} argues key rotation. ${replyHref}`,
          `Worth reading because the two sides name different failure modes.`,
        ].join("\n"),
    });
    expect(d.format).toBe("thread_worth_reading");
    expect(d.body).toMatch(/session/i);
    expect(d.body).toContain(rootHref);
    expect(d.evidence.uris.length).toBeGreaterThanOrEqual(1);
    expect(d.body.length).toBeLessThanOrEqual(2000);
  });

  it("(b) returns none when every thread is single-author", async () => {
    const solo = threadPosts({
      rootMs,
      replyMs,
      rootContent: "how old are you?",
      replyContent: "lol",
      replyAuthor: USER,
    });
    await expect(
      generateThreadWorthReading({
        scout: scoutTop([seedPost(USER, solo[0]!.post_id, solo[0]!.content, rootMs)]),
        appUrl: APP,
        nowMs: NOW,
        fetchThread: async () => solo,
        complete: noneComplete(),
      }),
    ).rejects.toThrow(/none:/);
  });

  it("(c) drops a bullet that cites a non-evidence link", async () => {
    const d = await generateThreadWorthReading({
      scout: scoutTop([seedPost(USER, posts[0]!.post_id, posts[0]!.content, rootMs)]),
      appUrl: APP,
      nowMs: NOW,
      fetchThread: async () => posts,
      complete: async () =>
        [
          `Session lifetime, two positions.`,
          `- ${profileHref(USER)} keeps idle expiry. ${rootHref}`,
          `- ${profileHref(USERB)} wants key rotation. ${replyHref}`,
          `- drop me ${EVIL}`,
          `Worth reading as a mechanism argument.`,
        ].join("\n"),
    });
    expect(d.body).toContain(rootHref);
    expect(d.body).not.toContain("evil.example");
  });

  it("(d) ignores a weeks-old thread even if Scout returned it", async () => {
    const staleMs = NOW - 21 * 86400000;
    const stale = threadPosts({
      rootMs: staleMs,
      replyMs: staleMs + 3600000,
      rootContent: "how old are you?",
      replyContent: "older than this window",
    });
    await expect(
      generateThreadWorthReading({
        scout: scoutTop([seedPost(USER, stale[0]!.post_id, stale[0]!.content, staleMs)]),
        appUrl: APP,
        nowMs: NOW,
        fetchThread: async () => stale,
        complete: noneComplete(),
      }),
    ).rejects.toThrow(/none:/);
  });
});

describe("the_disagreement", () => {
  const rootMs = NOW - 3 * 86400000;
  const replyMs = NOW - 2 * 86400000;
  const posts = threadPosts({
    rootMs,
    replyMs,
    rootContent: "Pkarr records should be signed only by the homeserver.",
    replyContent: "No — the user key must sign, or the homeserver can swap records.",
  });
  const rootHref = postHref(USER, posts[0]!.post_id);
  const replyHref = postHref(USERB, posts[1]!.post_id);

  it("(a) writes sides from opposing reply claims", async () => {
    const d = await generateTheDisagreement({
      scout: scoutTop([seedPost(USER, posts[0]!.post_id, posts[0]!.content, rootMs)]),
      appUrl: APP,
      nowMs: NOW,
      fetchThread: async () => posts,
      complete: async () =>
        [
          `Topic: who signs pkarr records.`,
          `Side A: ${profileHref(USER)} — homeserver-only signatures. ${rootHref}`,
          `Side B: ${profileHref(USERB)} — user key must sign. ${replyHref}`,
          `What would settle it: whether a homeserver-signed swap is accepted by resolvers.`,
        ].join("\n"),
    });
    expect(d.format).toBe("the_disagreement");
    expect(d.body).toMatch(/Side A/i);
    expect(d.body).toContain(rootHref);
    expect(d.body).toContain(replyHref);
  });

  it("(b) returns none when there is no reply-chain disagreement", async () => {
    await expect(
      generateTheDisagreement({
        scout: scoutTop([]),
        appUrl: APP,
        nowMs: NOW,
        fetchThread: async () => [],
        complete: noneComplete(),
      }),
    ).rejects.toThrow(/none:/);
  });

  it("(c) drops a bullet that cites a non-evidence link", async () => {
    const d = await generateTheDisagreement({
      scout: scoutTop([seedPost(USER, posts[0]!.post_id, posts[0]!.content, rootMs)]),
      appUrl: APP,
      nowMs: NOW,
      fetchThread: async () => posts,
      complete: async () =>
        [
          `Topic: who must sign pkarr records when a name moves homeservers.`,
          `- A ${rootHref}`,
          `- planted ${EVIL}`,
          `What would settle it is whether resolvers accept a homeserver-signed swap.`,
        ].join("\n"),
    });
    expect(d.body).toContain(rootHref);
    expect(d.body).not.toContain("evil.example");
  });

  it("(d) does not treat an out-of-window debate as current", async () => {
    const staleMs = NOW - 20 * 86400000;
    const stale = threadPosts({
      rootMs: staleMs,
      replyMs: staleMs + 1000,
      rootContent: "old claim",
      replyContent: "old counterclaim",
    });
    await expect(
      generateTheDisagreement({
        scout: scoutTop([seedPost(USER, stale[0]!.post_id, stale[0]!.content, staleMs)]),
        appUrl: APP,
        nowMs: NOW,
        fetchThread: async () => stale,
        complete: noneComplete(),
      }),
    ).rejects.toThrow(/none:/);
  });
});

describe("what_changed", () => {
  const docUrl = "https://pubky.org/Explore/Concepts/Homeserver.md";
  const commitUrl = "https://github.com/pubky/pubky-core/commit/abc123";
  const releaseUrl = "https://github.com/pubky/pubky-core/releases/tag/v0.9.0";

  it("(a) writes bullets from knowledge + ecosystem releases", async () => {
    const d = await generateWhatChanged({
      nowMs: NOW,
      listKnowledgeChanges: async () => [
        {
          source_id: "kb",
          path: "Homeserver.md",
          source_url: docUrl,
          ingested_at: new Date(NOW - 86400000).toISOString(),
          product: "pubky",
          status: "canonical",
        },
      ],
      listCommits: async () => [
        { repo: "pubky/pubky-core", html_url: commitUrl, message: "Tighten session expiry", date: "2026-09-04T00:00:00Z" },
      ],
      listReleases: async () => [
        {
          repo: "pubky/pubky-core",
          html_url: releaseUrl,
          name: "v0.9.0",
          tag_name: "v0.9.0",
          published_at: "2026-09-03T00:00:00Z",
        },
      ],
      complete: async () =>
        [
          `- Homeserver docs changed: session expiry is now explicit. ${docUrl}`,
          `- pubky-core commit: tighter expiry. ${commitUrl}`,
          `- pubky-core v0.9.0: session API. ${releaseUrl}`,
        ].join("\n"),
    });
    expect(d.format).toBe("what_changed");
    expect(d.body).toContain(docUrl);
    expect(d.evidence.uris).toEqual(expect.arrayContaining([docUrl, commitUrl, releaseUrl]));
  });

  it("(b) returns none when the index and releases are empty", async () => {
    await expect(
      generateWhatChanged({
        nowMs: NOW,
        listKnowledgeChanges: async () => [],
        listCommits: async () => [],
        listReleases: async () => [],
        complete: noneComplete(),
      }),
    ).rejects.toThrow(/none:/);
  });

  it("(c) drops a bullet that cites a non-evidence link", async () => {
    const d = await generateWhatChanged({
      nowMs: NOW,
      listKnowledgeChanges: async () => [
        {
          source_id: "kb",
          path: "Homeserver.md",
          source_url: docUrl,
          ingested_at: new Date(NOW - 86400000).toISOString(),
          product: "pubky",
          status: "canonical",
        },
      ],
      listCommits: async () => [],
      listReleases: async () => [],
      complete: async () =>
        [
          `- Homeserver docs changed: session expiry is now explicit. ${docUrl}`,
          `- Index note changed: the same page now states the idle timeout. ${docUrl}`,
          `- planted ${EVIL}`,
        ].join("\n"),
    });
    expect(d.body).toContain(docUrl);
    expect(d.body).not.toContain("evil.example");
  });

  it("(d) ignores stale releases and bitkit rows", async () => {
    await expect(
      generateWhatChanged({
        nowMs: NOW,
        listKnowledgeChanges: async () => [],
        listCommits: async () => [
          {
            repo: "synonymdev/bitkit-core",
            html_url: "https://github.com/synonymdev/bitkit-core/commit/fff",
            message: "wallet",
            date: "2026-09-04T00:00:00Z",
          },
        ],
        listReleases: async () => [
          {
            repo: "pubky/pubky-core",
            html_url: releaseUrl,
            name: "old",
            tag_name: "v0.1.0",
            published_at: "2020-01-01T00:00:00Z",
          },
          {
            repo: "synonymdev/bitkit-core",
            html_url: "https://github.com/synonymdev/bitkit-core/releases/tag/v1",
            name: "v1",
            tag_name: "v1",
            published_at: "2026-09-04T00:00:00Z",
          },
        ],
        complete: noneComplete(),
      }),
    ).rejects.toThrow(/none:/);
  });
});

describe("pubky_explained", () => {
  const source = "https://pubky.org/Glossary.md";
  const asked = `pubky://${USER}/pub/pubky.app/posts/${idAt(NOW - 86400000)}`;

  it("(a) answers a week's question without pasting the chunk", async () => {
    const chunk = "A pubky is a public key used as a user identifier. PASTE_MARKER_XYZ";
    const d = await generatePubkyExplained({
      nowMs: NOW,
      questions: [{ uri: asked, author_id: USER, content: "what is a pubky identity?" }],
      searchKnowledge: async () => ({ chunks: [{ content: chunk, source_url: source, status: "canonical" }] }),
      complete: async () =>
        [
          "A pubky is the public key that names an account, not a nickname you can collide with someone else.",
          "The homeserver stores public data at that name so others can resolve it without a central directory.",
          "Status is canonical: this is how identity is addressed on the public graph today.",
          `Sources: ${source}`,
        ].join("\n\n"),
    });
    expect(d.format).toBe("pubky_explained");
    expect(d.body).toContain(source);
    expect(d.body).not.toContain("PASTE_MARKER_XYZ");
    expect(d.evidence.uris).toContain(source);
  });

  it("(b) returns none when nobody asked a suitable question", async () => {
    await expect(
      generatePubkyExplained({
        nowMs: NOW,
        questions: [],
        searchKnowledge: async () => ({ chunks: [{ content: "x", source_url: source }] }),
        complete: noneComplete(),
      }),
    ).rejects.toThrow(/none:/);
  });

  it("(c) drops a bullet that cites a non-evidence link", async () => {
    const d = await generatePubkyExplained({
      nowMs: NOW,
      questions: [{ uri: asked, content: "what is pkarr?" }],
      searchKnowledge: async () => ({ chunks: [{ content: "pkarr is a key-addressable record.", source_url: source }] }),
      complete: async () =>
        [
          "Pkarr publishes signed records under a key so a name can move homeservers without a central directory.",
          "Resolvers read those records; they do not take a homeserver's word for the mapping.",
          `- planted ${EVIL}`,
          `Sources: ${source}`,
        ].join("\n"),
    });
    expect(d.body).toContain(source);
    expect(d.body).not.toContain("evil.example");
  });

  it("(d) does not pick a question from outside the window when using Scout", async () => {
    const staleId = idAt(NOW - 21 * 86400000);
    const scout = {
      mentions_of: { execute: async () => ({ posts: [] }) },
      search_posts: {
        execute: async () => ({
          posts: [
            seedPost(USER, staleId, "what is a pubky homeserver?", NOW - 21 * 86400000),
          ],
        }),
      },
    } as unknown as ScoutTools;
    await expect(
      generatePubkyExplained({
        nowMs: NOW,
        scout,
        botPk: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        searchKnowledge: async () => ({ chunks: [{ content: "x", source_url: source }] }),
        complete: noneComplete(),
      }),
    ).rejects.toThrow(/none:/);
  });
});

describe("release_radar", () => {
  const href = "https://github.com/pubky/pubky-core/releases/tag/v0.9.0";

  it("(a) writes one sentence per in-window ecosystem release", async () => {
    const d = await generateReleaseRadar({
      nowMs: NOW,
      listReleases: async () => [
        {
          repo: "pubky/pubky-core",
          html_url: href,
          name: "v0.9.0",
          tag_name: "v0.9.0",
          published_at: "2026-09-02T00:00:00Z",
          body: "Session expiry is now configurable.",
        },
      ],
      complete: async () =>
        `pubky-core v0.9.0: session expiry is now configurable on the homeserver, which is the change to read. ${href}`,
    });
    expect(d.format).toBe("release_radar");
    expect(d.body).toMatch(/session expiry/i);
    expect(d.body).toContain(href);
  });

  it("(b) returns none when nothing dated is in the window", async () => {
    await expect(
      generateReleaseRadar({
        nowMs: NOW,
        listReleases: async () => [
          {
            repo: "pubky/pubky-core",
            html_url: "https://github.com/pubky/pubky-core/releases/tag/v0.1.0",
            name: "old",
            tag_name: "v0.1.0",
            published_at: "2020-01-01T00:00:00Z",
          },
        ],
        complete: noneComplete(),
      }),
    ).rejects.toThrow(/none:/);
  });

  it("(c) drops a bullet that cites a non-evidence link", async () => {
    const d = await generateReleaseRadar({
      nowMs: NOW,
      listReleases: async () => [
        {
          repo: "pubky/pubky-core",
          html_url: href,
          name: "v0.9.0",
          tag_name: "v0.9.0",
          published_at: "2026-09-02T00:00:00Z",
          body: "Session expiry.",
        },
      ],
      complete: async () =>
        [`pubky-core v0.9.0: session expiry is the change to read, not the tag name. ${href}`, `- planted ${EVIL}`].join(
          "\n",
        ),
    });
    expect(d.body).toContain(href);
    expect(d.body).not.toContain("evil.example");
  });

  it("(d) drops bitkit and out-of-window rows", async () => {
    await expect(
      generateReleaseRadar({
        nowMs: NOW,
        windowDays: 3,
        listReleases: async () => [
          {
            repo: "synonymdev/bitkit-core",
            html_url: "https://github.com/synonymdev/bitkit-core/releases/tag/v9",
            name: "v9",
            tag_name: "v9",
            published_at: "2026-09-04T00:00:00Z",
            body: "wallet",
          },
          {
            repo: "pubky/pubky-core",
            html_url: href,
            name: "v0.8.0",
            tag_name: "v0.8.0",
            published_at: "2026-08-20T00:00:00Z",
          },
        ],
        complete: noneComplete(),
      }),
    ).rejects.toThrow(/none:/);
  });
});

describe("new_connection", () => {
  const postId = idAt(NOW - 2 * 86400000);
  const uri = `pubky://${USER}/pub/pubky.app/posts/${postId}`;
  const href = postHref(USER, postId);
  const uriB = `pubky://${USERB}/pub/pubky.app/posts/${idAt(NOW - 86400000)}`;

  function scoutOk(): ScoutTools {
    return {
      get_emerging_topics: { execute: async () => ({ topics: [{ label: "pkarr", delta: 4, distinct_taggers: 6 }] }) },
      search_posts: {
        execute: async () => ({
          posts: [
            { ...seedPost(USER, postId, "pkarr note", NOW - 2 * 86400000), uri },
            { ...seedPost(USERB, idAt(NOW - 86400000), "pkarr two", NOW - 86400000), uri: uriB },
          ],
        }),
      },
      get_relationship: { execute: async () => ({ a_follows_b: true, b_follows_a: false, shared_taggers: 2 }) },
    } as unknown as ScoutTools;
  }

  it("(a) writes one or two sentences with profile and post links", async () => {
    const d = await generateNewConnection({
      scout: scoutOk(),
      appUrl: APP,
      nowMs: NOW,
      complete: async () =>
        `${profileHref(USER)} and ${profileHref(USERB)} both showed up on recent pkarr posts, e.g. ${href}. Graph coincidence, not an introduction.`,
    });
    expect(d.format).toBe("new_connection");
    expect(d.body).toContain(profileHref(USER));
    expect(d.body).toContain(profileHref(USERB));
    expect(d.body).toContain(href);
    expect(d.body).not.toMatch(/^\s*\(/);
  });

  it("(b) returns none when Scout has no emerging topic", async () => {
    const scout = {
      get_emerging_topics: { execute: async () => ({ topics: [] }) },
      search_posts: { execute: async () => ({ posts: [] }) },
      get_relationship: { execute: async () => ({}) },
    } as unknown as ScoutTools;
    await expect(generateNewConnection({ scout, appUrl: APP, nowMs: NOW, complete: noneComplete() })).rejects.toThrow(
      /none:/,
    );
  });

  it("(c) drops a bullet that cites a non-evidence link", async () => {
    const d = await generateNewConnection({
      scout: scoutOk(),
      appUrl: APP,
      nowMs: NOW,
      complete: async () =>
        [`${profileHref(USER)} and ${profileHref(USERB)} on pkarr, see ${href}.`, `- planted ${EVIL}`].join("\n"),
    });
    expect(d.body).toContain(href);
    expect(d.body).not.toContain("evil.example");
  });

  it("(d) returns none when the only posts are outside the window", async () => {
    const staleId = idAt(NOW - 21 * 86400000);
    const scout = {
      get_emerging_topics: { execute: async () => ({ topics: [{ label: "pkarr", delta: 4 }] }) },
      search_posts: {
        execute: async () => ({
          posts: [
            seedPost(USER, staleId, "pkarr old", NOW - 21 * 86400000),
            seedPost(USERB, idAt(NOW - 20 * 86400000), "pkarr old 2", NOW - 20 * 86400000),
          ],
        }),
      },
      get_relationship: { execute: async () => ({}) },
    } as unknown as ScoutTools;
    await expect(generateNewConnection({ scout, appUrl: APP, nowMs: NOW, complete: noneComplete() })).rejects.toThrow(
      /none:/,
    );
  });
});

describe("none contract", () => {
  it("DraftRejectedError message is matched by the CLI none path", () => {
    const e = new DraftRejectedError("release_radar", "none: no Pubky-ecosystem releases in the window");
    expect(/: none:/.test(e.message)).toBe(true);
  });
});
