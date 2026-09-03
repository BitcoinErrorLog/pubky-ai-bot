import { afterEach, describe, expect, it, vi } from "vitest";
import { existingReply, isDirNotFound, SessionTransport, signinOrSignup } from "./homeserver.js";
import { log } from "./log.js";
import { POSTS_PREFIX } from "./types.js";

const BOT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

interface FakeStorage {
  listCalls: Array<{ cursor: string | null; reverse: boolean | null; limit: number | null }>;
  pages: string[][];
  listError?: Error;
  json: Record<string, { parent?: string }>;
}

function transportWith(storage: FakeStorage): SessionTransport {
  const pubky = {
    publicStorage: {
      list: async (_addr: string, cursor?: string | null, reverse?: boolean | null, limit?: number | null) => {
        if (storage.listError) throw storage.listError;
        storage.listCalls.push({ cursor: cursor ?? null, reverse: reverse ?? null, limit: limit ?? null });
        return storage.pages.shift() ?? [];
      },
      getJson: async (url: string) => {
        const j = storage.json[url];
        if (!j) throw new Error("not found");
        return j;
      },
    },
  };
  return new SessionTransport(BOT, {} as never, pubky as never, {} as never);
}

describe("SessionTransport.listPosts (F-05)", () => {
  it("propagates list errors — never swallows them into an empty listing", async () => {
    const t = transportWith({ listCalls: [], pages: [], listError: new Error("homeserver unreachable"), json: {} });
    await expect(t.listPosts()).rejects.toThrow(/homeserver unreachable/);
    await expect(existingReply(t, "pubky://x/pub/pubky.app/posts/0000000000001")).rejects.toThrow(
      /homeserver unreachable/,
    );
  });

  it("treats 404 directory-not-found (pre-first-PUT) as a definitive empty listing", async () => {
    const err = new Error("Request failed: Server responded with an error: 404 Not Found - Directory Not Found");
    expect(isDirNotFound(err)).toBe(true);
    expect(isDirNotFound(new Error("ECONNREFUSED"))).toBe(false);
    const t = transportWith({ listCalls: [], pages: [], listError: err, json: {} });
    await expect(t.listPosts()).resolves.toEqual([]);
  });

  it("propagates per-post fetch errors — an unreadable post is not silently skipped", async () => {
    const t = transportWith({ listCalls: [], pages: [["pubky://" + BOT + POSTS_PREFIX + "A"]], json: {} });
    await expect(t.listPosts()).rejects.toThrow(/not found/);
  });

  it("pages newest-first beyond the first 200 until the listing is exhausted", async () => {
    const page1 = Array.from({ length: 200 }, (_, i) => `pubky://${BOT}${POSTS_PREFIX}P${String(i).padStart(3, "0")}`);
    const page2 = [`pubky://${BOT}${POSTS_PREFIX}LAST`];
    const json: Record<string, { parent?: string }> = {};
    for (const u of page1) json[u] = { parent: "pubky://x/pub/pubky.app/posts/0000000000001" };
    json[page2[0]] = { parent: "pubky://x/pub/pubky.app/posts/0000000000002" };
    const storage: FakeStorage = { listCalls: [], pages: [page1, page2], json };
    const t = transportWith(storage);
    const posts = await t.listPosts();
    expect(posts).toHaveLength(201);
    expect(storage.listCalls).toHaveLength(2);
    expect(storage.listCalls[0].cursor).toBeNull();
    expect(storage.listCalls[0].reverse).toBe(true);
    expect(storage.listCalls[1].cursor, "second page keyed by last entry of first page").toBe(page1[199]);
    const found = await existingReply(
      transportWith({ listCalls: [], pages: [page1, page2], json }),
      "pubky://x/pub/pubky.app/posts/0000000000002",
    );
    expect(found).toBe(`pubky://${BOT}${POSTS_PREFIX}LAST`);
  });

  it("stops paging as soon as untilParent is found", async () => {
    const page1 = Array.from({ length: 200 }, (_, i) => `pubky://${BOT}${POSTS_PREFIX}P${String(i).padStart(3, "0")}`);
    const json: Record<string, { parent?: string }> = {};
    for (const u of page1) json[u] = { parent: "pubky://x/pub/pubky.app/posts/0000000000001" };
    json[page1[3]] = { parent: "pubky://x/pub/pubky.app/posts/0000000000007" };
    const storage: FakeStorage = { listCalls: [], pages: [page1], json };
    const found = await existingReply(transportWith(storage), "pubky://x/pub/pubky.app/posts/0000000000007");
    expect(found).toBe(`pubky://${BOT}${POSTS_PREFIX}P003`);
    expect(storage.listCalls, "no further pages fetched after a match").toHaveLength(1);
  });
});

describe("signinOrSignup", () => {
  const botPk = "ufibwbmed6jeq9k4p583go95wofakh9fwpp4k734trq79pd9u1uy";
  const session = { id: "sess" } as never;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function pkarrMissing(): Error {
    const err = new Error(
      `Pkarr operation failed: Pkarr record is malformed or missing required data: No HTTPS endpoints found in PKARR record for \`_pubky.${botPk}\``,
    );
    err.name = "PkarrError";
    return err;
  }

  it("signs up once on missing pkarr HTTPS endpoints, then drops the token", async () => {
    let signins = 0;
    let signups = 0;
    const prev = process.env.JEB_SIGNUP_TOKEN;
    process.env.JEB_SIGNUP_TOKEN = "once";
    const opts = { homeserverPk: "homeserverpk", signupToken: "once" };
    try {
      const got = await signinOrSignup(
        {
          signin: async () => {
            signins += 1;
            throw pkarrMissing();
          },
          signup: async (_hs, token) => {
            signups += 1;
            expect(token).toBe("once");
            return session;
          },
        },
        opts,
        botPk,
        (pk) => pk,
      );
      expect(got).toBe(session);
      expect(signins).toBe(1);
      expect(signups).toBe(1);
      expect(opts.signupToken).toBeUndefined();
      expect(process.env.JEB_SIGNUP_TOKEN).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.JEB_SIGNUP_TOKEN;
      else process.env.JEB_SIGNUP_TOKEN = prev;
    }
  });

  it("logs one info line on signup naming the account, never the token (R-05)", async () => {
    const spy = vi.spyOn(log, "info").mockImplementation(() => log);
    const prev = process.env.JEB_SIGNUP_TOKEN;
    process.env.JEB_SIGNUP_TOKEN = "secret-signup-token";
    const opts = { homeserverPk: "homeserverpk", signupToken: "secret-signup-token" };
    try {
      await signinOrSignup(
        {
          signin: async () => {
            throw pkarrMissing();
          },
          signup: async () => session,
        },
        opts,
        botPk,
        (pk) => pk,
      );
      const signupCalls = spy.mock.calls.filter((c) => String(c[1]).includes("signup performed"));
      expect(signupCalls).toHaveLength(1);
      const [fields, msg] = signupCalls[0] as [Record<string, unknown>, string];
      expect(msg).toBe(`signup performed for _pubky.${botPk}`);
      expect(fields.homeserver).toBe("homeserverpk");
      expect(JSON.stringify(signupCalls[0])).not.toContain("secret-signup-token");
    } finally {
      if (prev === undefined) delete process.env.JEB_SIGNUP_TOKEN;
      else process.env.JEB_SIGNUP_TOKEN = prev;
    }
  });

  it("does not signup on 503 or timeout", async () => {
    let signups = 0;
    const opts = { homeserverPk: "homeserverpk", signupToken: "once" };
    await expect(
      signinOrSignup(
        {
          signin: async () => {
            throw new Error("503 Service Unavailable");
          },
          signup: async () => {
            signups += 1;
            return session;
          },
        },
        opts,
        botPk,
        (pk) => pk,
      ),
    ).rejects.toThrow(/503/);
    await expect(
      signinOrSignup(
        {
          signin: async () => {
            throw new Error("timeout");
          },
          signup: async () => {
            signups += 1;
            return session;
          },
        },
        opts,
        botPk,
        (pk) => pk,
      ),
    ).rejects.toThrow(/timeout/);
    expect(signups).toBe(0);
    expect(opts.signupToken).toBe("once");
  });
});
