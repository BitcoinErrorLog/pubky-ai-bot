import { createServer, type Server } from "node:http";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isNotRegistered } from "./auth-error.js";
import type { Config } from "./config.js";
import { configFromProcessEnv } from "./config.js";
import { Semaphore } from "./concurrency.js";
import { assertContractGuard } from "./contract-guard.js";
import { Store } from "./db.js";
import { closeServer, listenAdmin, listenHealth } from "./health.js";
import { fetchJson } from "./http.js";
import { InjectionDetector } from "./injection-detector.js";
import { secretFromFile } from "./keys.js";
import { Nexus, walkAncestors } from "./nexus.js";
import { reasonOne } from "./reason.js";
import type { PostView } from "./types.js";

const USER = "1111111111111111111111111111111111111111111111111111";
const BOT = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const DB = process.env.DATABASE_URL ?? "postgres://johncarvalho@127.0.0.1:5432/jeb_stage1_test";

function view(author: string, id: string, replied?: string | null): PostView {
  const uri = `pubky://${author}/pub/pubky.app/posts/${id}`;
  return {
    details: { content: "hi", id, indexed_at: 1, author, kind: "short", uri },
    relationships: { replied: replied ?? null },
  };
}

function listen(handler: (url: URL, res: import("node:http").ServerResponse) => void): Promise<{
  server: Server;
  url: string;
}> {
  const server = createServer((req, res) => {
    handler(new URL(req.url ?? "/", "http://127.0.0.1"), res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

async function ready(server: Server): Promise<number> {
  if (!server.listening) {
    await new Promise<void>((r) => server.once("listening", () => r()));
  }
  return (server.address() as AddressInfo).port;
}

describe("thread-cap forgery (F4 / F-03)", () => {
  it("treats an unresolvable parent as the mention root", async () => {
    const leaf = view(USER, "0000000000001", "pubky://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/pub/pubky.app/posts/FORGED0000001");
    const { server, url } = await listen((u, res) => {
      if (u.pathname.includes("/FORGED0000001")) {
        res.writeHead(404);
        res.end();
        return;
      }
      if (u.pathname.includes("/0000000000001")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(leaf));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    try {
      const nexus = new Nexus(url, 2000);
      const walked = await walkAncestors(nexus, leaf, 25);
      expect(walked.unresolvedParent).toBe(true);
      expect(walked.chain).toHaveLength(1);
      const root = walked.unresolvedParent ? leaf.details.uri : walked.chain.at(-1)?.details.uri;
      expect(root).toBe(leaf.details.uri);
    } finally {
      await closeServer(server);
    }
  });

  it("skips canned when the ancestor chain already has a bot reply", async () => {
    const mentionId = "CAPPED0000001";
    const botId = "BOTREPLY00001";
    const mentionUri = `pubky://${USER}/pub/pubky.app/posts/${mentionId}`;
    const botUri = `pubky://${BOT}/pub/pubky.app/posts/${botId}`;
    const mention = view(USER, mentionId, botUri);
    const botPost = view(BOT, botId, null);
    const { server, url } = await listen((u, res) => {
      if (u.pathname.endsWith("/details")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ name: "n", id: USER, bio: null }));
        return;
      }
      if (u.pathname.includes(mentionId)) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(mention));
        return;
      }
      if (u.pathname.includes(botId)) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(botPost));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const store = new Store(DB);
    await store.migrate();
    await store.pool.query("DELETE FROM work_queue WHERE mention_key = $1", [mentionUri]);
    await store.pool.query("DELETE FROM publish_requests WHERE mention_key = $1", [mentionUri]);
    await store.pool.query("DELETE FROM handled_mentions WHERE mention_key = $1", [mentionUri]);
    expect(await store.claim(mentionUri, USER, BOT)).toBe("claimed");
    await store.enqueueWork(mentionUri, USER, "mention", { mentionKey: mentionUri });
    const queued = await store.pool.query<{ id: string; mention_key: string; author: string }>(
      "SELECT id, mention_key, author FROM work_queue WHERE mention_key = $1",
      [mentionUri],
    );
    expect(queued.rows).toHaveLength(1);
    const job = {
      id: Number(queued.rows[0].id),
      mention_key: queued.rows[0].mention_key,
      author: queued.rows[0].author,
    };
    const cfg = {
      cannedReply: "canned-should-not-publish",
      blocklist: new Set<string>(),
      maxRepliesPerThread: 1,
      maxPerUserPerHour: 100,
      dailyTokenBudget: 2_000_000,
      modelDelayMs: 0,
      model: "canned",
    } as Config;
    try {
      await reasonOne(cfg, store, new Nexus(url, 2000), new InjectionDetector(), BOT, job!);
      const pub = await store.pool.query("SELECT id FROM publish_requests WHERE mention_key = $1", [mentionUri]);
      expect(pub.rows).toHaveLength(0);
      const row = await store.get(mentionUri);
      expect(row?.status).toBe("skipped");
    } finally {
      await store.close();
      await closeServer(server);
    }
  });
});

describe("concurrency and timeouts (F-04)", () => {
  it("bounds Semaphore to configured max", async () => {
    const sem = new Semaphore(2);
    let peak = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        sem.run(async () => {
          peak = Math.max(peak, sem.inFlight);
          await new Promise((r) => setTimeout(r, 25));
        }),
      ),
    );
    expect(peak).toBe(2);
  });

  it("aborts outbound fetch after timeout", async () => {
    const { server, url } = await listen((_u, _res) => {
      /* hang until client abort */
    });
    try {
      await expect(fetchJson(new URL("/slow", url), 40)).rejects.toThrow();
    } finally {
      await closeServer(server);
    }
  });
});

describe("admin / health surface (F2 / F-12)", () => {
  let store: Store;
  beforeAll(async () => {
    store = new Store(DB);
    await store.migrate();
  });
  afterAll(async () => {
    await store.close();
  });

  it("returns 404 for /admin when ADMIN_TOKEN is unset", async () => {
    const server = listenAdmin(0, undefined, store, "127.0.0.1");
    const port = await ready(server);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/admin/switch/replies`, { method: "POST", body: "{}" });
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("");
    } finally {
      await closeServer(server);
    }
  });

  it("rejects a wrong token with 401 and accepts the real token", async () => {
    const server = listenAdmin(0, "correct-token", store, "127.0.0.1");
    const port = await ready(server);
    try {
      const bad = await fetch(`http://127.0.0.1:${port}/admin/switch/replies`, {
        method: "POST",
        headers: { authorization: "Bearer wrong-token" },
        body: JSON.stringify({ on: false }),
      });
      expect(bad.status).toBe(401);
      const ok = await fetch(`http://127.0.0.1:${port}/admin/switch/replies`, {
        method: "POST",
        headers: { authorization: "Bearer correct-token" },
        body: JSON.stringify({ on: false }),
      });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ name: "replies", on: false });
    } finally {
      await store.setSwitch("replies", false);
      await closeServer(server);
    }
  });

  it("health extra includes publisher_auth and never returns a stack", async () => {
    const server = listenHealth(0, () => Date.now(), "127.0.0.1", () => ({ publisher_auth: "failed" }));
    const port = await ready(server);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { publisher_auth: string };
      expect(body.publisher_auth).toBe("failed");
      expect(JSON.stringify(body)).not.toMatch(/Error:|\/Volumes\/|node_modules/);
    } finally {
      await closeServer(server);
    }
  });
});

describe("contract adapter guard (F16 / F-14)", () => {
  it("refuses unless JEB_CONTRACT_MODE=1 and Nexus is loopback", () => {
    expect(() => assertContractGuard("http://127.0.0.1:9", undefined)).toThrow(/JEB_CONTRACT_MODE/);
    expect(() => assertContractGuard("https://nexus.staging.pubky.app", "1")).toThrow(/loopback/);
    expect(() => assertContractGuard("http://evil.example", "1")).toThrow(/loopback/);
    expect(() => assertContractGuard("http://127.0.0.1:9", "1")).not.toThrow();
    expect(() => assertContractGuard("http://localhost:8080", "1")).not.toThrow();
  });
});

describe("signup classification (F12)", () => {
  it("treats only definitive not-registered errors as signup-eligible", () => {
    expect(isNotRegistered(new Error("user is not registered"))).toBe(true);
    expect(isNotRegistered(new Error("ECONNREFUSED"))).toBe(false);
    expect(isNotRegistered(new Error("timeout"))).toBe(false);
    expect(isNotRegistered(new Error("502 Bad Gateway"))).toBe(false);
    expect(isNotRegistered(new Error("500 internal"))).toBe(false);
  });
});

describe("key file (F7 / F-07 / F-08)", () => {
  it("loads a 0600 hex file and rejects world-readable mode", () => {
    const dir = mkdtempSync(join(tmpdir(), "jeb-key-"));
    const path = join(dir, "key");
    writeFileSync(path, `${"ab".repeat(32)}\n`, { mode: 0o600 });
    expect(secretFromFile(path)).toBe("ab".repeat(32));
    chmodSync(path, 0o644);
    expect(() => secretFromFile(path)).toThrow(/0600/);
  });
});

describe("config validation privacy (F6 / F-06)", () => {
  it("does not echo secret field values on zod failure", () => {
    const prev = process.env.DATABASE_URL;
    const hex = process.env.PUBKY_BOT_SECRET_KEY_HEX;
    process.env.DATABASE_URL = "";
    process.env.PUBKY_BOT_SECRET_KEY_HEX = "aa".repeat(32);
    try {
      expect(() => configFromProcessEnv({ requireSecret: true })).toThrow(/invalid config/);
      try {
        configFromProcessEnv({ requireSecret: true });
      } catch (e) {
        const msg = String(e);
        expect(msg).not.toContain("aa".repeat(32));
        expect(msg).not.toMatch(/received/i);
      }
    } finally {
      if (prev === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prev;
      if (hex === undefined) delete process.env.PUBKY_BOT_SECRET_KEY_HEX;
      else process.env.PUBKY_BOT_SECRET_KEY_HEX = hex;
    }
  });
});

describe("Nexus author id (F-10 / F-11)", () => {
  it("rejects non-z32 ids before URL interpolation", async () => {
    const nexus = new Nexus("http://127.0.0.1:9", 200);
    await expect(nexus.notifications("../evil", null)).rejects.toThrow(/invalid author id/);
    await expect(nexus.user("not-a-key")).rejects.toThrow(/invalid author id/);
  });
});
