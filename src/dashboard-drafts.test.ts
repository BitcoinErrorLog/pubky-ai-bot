import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { Store } from "./db.js";
import { closeServer, listenAdmin } from "./health.js";
import { configFromProcessEnv } from "./config.js";
import {
  ADMIN_COOKIE,
  CSRF_COOKIE,
  adminCookieFlags,
  parseCookies,
  renderDraftsPage,
  sessionCsrf,
} from "./dashboard-drafts.js";
import type { Draft, DraftRow } from "./drafts/types.js";

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

  it("reuses the session CSRF token and sets Secure on https", async () => {
    const csrfDraftId = await store.insertDraft(sample("csrf session body"));
    const server = listenAdmin(0, TOKEN, store, "127.0.0.1", configFromProcessEnv({ requireSecret: false }));
    const port = await ready(server);
    try {
      const first = await fetch(`http://127.0.0.1:${port}/admin/drafts`, {
        headers: { authorization: `Bearer ${TOKEN}`, "x-forwarded-proto": "https" },
      });
      expect(first.status).toBe(200);
      const firstHtml = await first.text();
      const csrf = /name="csrf" value="([^"]+)"/.exec(firstHtml)?.[1];
      expect(csrf).toMatch(/^[0-9a-f]{64}$/i);
      const setCookie = (first.headers.getSetCookie?.() ?? [first.headers.get("set-cookie") ?? ""]).join("\n");
      expect(setCookie).toMatch(/HttpOnly/i);
      expect(setCookie).toMatch(/SameSite=Strict/i);
      expect(setCookie).toMatch(/Secure/i);
      const second = await fetch(`http://127.0.0.1:${port}/admin/drafts`, {
        headers: {
          authorization: `Bearer ${TOKEN}`,
          cookie: `${CSRF_COOKIE}=${csrf}`,
          "x-forwarded-proto": "https",
        },
      });
      expect(await second.text()).toContain(`name="csrf" value="${csrf}"`);
    } finally {
      await store.pool.query("DELETE FROM drafts WHERE id = $1", [csrfDraftId]);
      await closeServer(server);
    }
  });
});

describe("dashboard evidence hrefs and csrf helpers", () => {
  it("renders javascript and data URIs as plain text", () => {
    const row = {
      id: 1,
      format: "what_changed",
      title: "t",
      body: "ok",
      status: "draft",
      evidence: { uris: ["javascript:alert(1)", "https://pubky.app/x", "data:text/html,x"], tool_trace: [], voice_violations: [] },
      created_at: new Date(),
    } as unknown as DraftRow;
    const html = renderDraftsPage([row], "csrf");
    expect(html).toContain("javascript:alert(1)");
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('href="https://pubky.app/x"');
    expect(html).not.toContain('href="data:');
  });

  it("reuses a 64-hex CSRF cookie and marks cookies HttpOnly", () => {
    const existing = "cd".repeat(32);
    expect(sessionCsrf(existing)).toBe(existing);
    expect(sessionCsrf("short")).toHaveLength(64);
    expect(adminCookieFlags(true)).toContain("HttpOnly");
    expect(adminCookieFlags(true)).toContain("Secure");
    expect(adminCookieFlags(false)).not.toContain("Secure");
  });
});
