import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { Store } from "./db.js";
import { closeServer, listenAdmin } from "./health.js";
import { configFromProcessEnv } from "./config.js";
import { ADMIN_COOKIE, CSRF_COOKIE, parseCookies } from "./dashboard-drafts.js";
import type { Draft } from "./drafts/types.js";

const DB = process.env.DATABASE_URL ?? "postgres://johncarvalho@127.0.0.1:5432/jeb_stage1_test";
const TOKEN = "drafts-admin-test-token";

function sample(body: string): Draft {
  return {
    format: "what_changed",
    title: "test draft",
    body,
    evidence: { uris: ["https://pubky.org/Glossary.md"], tool_trace: [], voice_violations: [] },
    created_at: new Date().toISOString(),
  };
}

async function ready(server: import("node:http").Server): Promise<number> {
  if (!server.listening) await new Promise<void>((r) => server.once("listening", () => r()));
  return (server.address() as AddressInfo).port;
}

function cookieHeader(res: Response): string {
  const raw = res.headers.getSetCookie?.() ?? [];
  const cookies = raw.length > 0 ? raw : [res.headers.get("set-cookie") ?? ""];
  const parsed: Record<string, string> = {};
  for (const line of cookies) {
    Object.assign(parsed, parseCookies(line.split(";")[0]));
  }
  return Object.entries(parsed)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("; ");
}

describe("admin drafts review page", () => {
  let store: Store;
  let draftId: number;

  beforeAll(async () => {
    process.env.DATABASE_URL ??= DB;
    store = new Store(DB);
    await store.migrate();
    await store.pool.query("DELETE FROM drafts WHERE title = 'test draft'");
    draftId = await store.insertDraft(sample("Hello **world** and <script>x</script>"));
  });

  afterAll(async () => {
    await store.pool.query("DELETE FROM drafts WHERE title = 'test draft'");
    await store.close();
  });

  it("GET /admin/drafts requires the admin token and sanitizes the preview", async () => {
    const server = listenAdmin(0, TOKEN, store, "127.0.0.1", configFromProcessEnv({ requireSecret: false }));
    const port = await ready(server);
    try {
      const anon = await fetch(`http://127.0.0.1:${port}/admin/drafts`);
      expect(anon.status).toBe(401);
      const res = await fetch(`http://127.0.0.1:${port}/admin/drafts`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Pending drafts");
      expect(html).toContain(`data-draft-id="${draftId}"`);
      expect(html).toContain("<strong>world</strong>");
      expect(html).not.toMatch(/<script>x<\/script>/);
      expect(html).toContain("&lt;script&gt;");
    } finally {
      await closeServer(server);
    }
  });

  it("POST actions are CSRF-protected and reject GET", async () => {
    const server = listenAdmin(0, TOKEN, store, "127.0.0.1", configFromProcessEnv({ requireSecret: false }));
    const port = await ready(server);
    try {
      const page = await fetch(`http://127.0.0.1:${port}/admin/drafts`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      const cookies = cookieHeader(page);
      const html = await page.text();
      const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
      expect(csrf).toBeTruthy();

      const get = await fetch(`http://127.0.0.1:${port}/admin/drafts/${draftId}/approve`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(get.status).toBe(405);

      const noCsrf = await fetch(`http://127.0.0.1:${port}/admin/drafts/${draftId}/reject`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          cookie: cookies,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "reason=nope",
      });
      expect(noCsrf.status).toBe(403);

      const reject = await fetch(`http://127.0.0.1:${port}/admin/drafts/${draftId}/reject`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          cookie: `${cookies}; ${CSRF_COOKIE}=${csrf}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: `csrf=${csrf}&reason=not+useful`,
      });
      expect(reject.status).toBe(200);
      expect(await reject.text()).toContain("rejected");
      const row = await store.getDraft(draftId);
      expect(row?.status).toBe("rejected");
      expect(cookies).toContain(ADMIN_COOKIE);
    } finally {
      await closeServer(server);
    }
  });
});
