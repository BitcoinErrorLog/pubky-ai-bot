import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Store } from "./db.js";
import type { Config } from "./config.js";
import { metrics } from "./metrics.js";
import type { SwitchName } from "./switches.js";
import {
  csrfOk,
  handleDraftsGet,
  handleDraftsPost,
  parseCookies,
  parseForm,
  readBody,
  sessionCsrf,
  ADMIN_COOKIE,
  CSRF_COOKIE,
} from "./dashboard-drafts.js";

export function listenHealth(
  port: number,
  lastPoll: () => number | null,
  host = "127.0.0.1",
  extra: () => Record<string, unknown> | Promise<Record<string, unknown>> = () => ({}),
): Server {
  const server = createServer(async (req, res) => {
    try {
      const url = req.url ?? "/";
      if (url.startsWith("/healthz")) {
        const ts = lastPoll();
        const lastPollAgeMs = ts === null ? null : Date.now() - ts;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, lastPollAgeMs, ...(await extra()) }));
        return;
      }
      if (url.startsWith("/metrics")) {
        const body = await metrics.getPublicMetrics();
        res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
        res.end(body);
        return;
      }
      res.writeHead(404);
      res.end();
    } catch {
      res.writeHead(500);
      res.end();
    }
  });
  server.listen(port, host);
  return server;
}

function tokenOk(got: string | undefined, expected: string): boolean {
  if (!got) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function adminCredential(req: IncomingMessage, expected: string): boolean {
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (tokenOk(bearer, expected)) return true;
  const cookies = parseCookies(req.headers.cookie);
  return tokenOk(cookies[ADMIN_COOKIE], expected);
}

const SWITCH_ALLOWED = new Set(["consumption", "generation", "replies", "scout", "web", "proactive", "weekly", "collections", "global"]);

async function handleSwitchPost(req: IncomingMessage, res: ServerResponse, store: Store, name: string): Promise<void> {
  if (!SWITCH_ALLOWED.has(name)) {
    res.writeHead(404);
    res.end();
    return;
  }
  let body = "";
  for await (const chunk of req) body += chunk;
  let on = true;
  try {
    const parsed = JSON.parse(body || "{}") as { on?: boolean };
    if (typeof parsed.on === "boolean") on = parsed.on;
  } catch {
    /* default on */
  }
  await store.setSwitch(name as SwitchName | "global", on);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ name, on }));
}

export function listenAdmin(
  port: number,
  token: string | undefined,
  store: Store,
  host = "127.0.0.1",
  _cfg?: Config,
): Server {
  const server = createServer(async (req, res) => {
    try {
      if (!token) {
        res.writeHead(404);
        res.end();
        return;
      }
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (!adminCredential(req, token)) {
        res.writeHead(401);
        res.end();
        return;
      }
      if (url.pathname === "/admin/drafts" && (req.method === "GET" || req.method === "HEAD")) {
        const cookies = parseCookies(req.headers.cookie);
        const csrf = sessionCsrf(cookies[CSRF_COOKIE]);
        const forwarded = typeof req.headers["x-forwarded-proto"] === "string" ? req.headers["x-forwarded-proto"] : "";
        const secure = forwarded === "https" || Boolean((req.socket as { encrypted?: boolean }).encrypted);
        await handleDraftsGet(store, res, csrf, token, secure);
        return;
      }
      const draftPost = /^\/admin\/drafts\/(\d+)\/(approve|reject|regenerate)$/.exec(url.pathname);
      if (draftPost) {
        if (req.method !== "POST") {
          res.writeHead(405, { allow: "POST" });
          res.end();
          return;
        }
        const body = await readBody(req);
        const fields = parseForm(body, req.headers["content-type"]);
        const headerCsrf = typeof req.headers["x-csrf-token"] === "string" ? req.headers["x-csrf-token"] : undefined;
        const cookies = parseCookies(req.headers.cookie);
        if (!csrfOk(fields.csrf ?? headerCsrf, cookies[CSRF_COOKIE])) {
          res.writeHead(403);
          res.end("csrf");
          return;
        }
        const out = await handleDraftsPost({
          store,
          action: draftPost[2] as "approve" | "reject" | "regenerate",
          id: Number(draftPost[1]),
          fields,
        });
        res.writeHead(out.status, { "content-type": "text/plain; charset=utf-8" });
        res.end(out.body);
        return;
      }
      const m = /^\/admin\/switch\/([a-z]+)$/.exec(url.pathname);
      if (req.method !== "POST" || !m) {
        res.writeHead(404);
        res.end();
        return;
      }
      await handleSwitchPost(req, res, store, m[1]);
    } catch {
      res.writeHead(500);
      res.end();
    }
  });
  server.listen(port, host);
  return server;
}

export async function closeServer(server: Server | null): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
