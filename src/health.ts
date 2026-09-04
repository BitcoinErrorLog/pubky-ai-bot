import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Store } from "./db.js";
import { metrics } from "./metrics.js";
import type { SwitchName } from "./switches.js";

export function listenHealth(
  port: number,
  lastPoll: () => number | null,
  host = "127.0.0.1",
  extra: () => Record<string, unknown> = () => ({}),
): Server {
  const server = createServer(async (req, res) => {
    try {
      const url = req.url ?? "/";
      if (url.startsWith("/healthz")) {
        const ts = lastPoll();
        const lastPollAgeMs = ts === null ? null : Date.now() - ts;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, lastPollAgeMs, ...extra() }));
        return;
      }
      if (url.startsWith("/metrics")) {
        // Public surface: security events are exposed only as an unlabeled
        // total; the per-rule breakdown stays internal (oracle hygiene).
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

export function listenAdmin(port: number, token: string | undefined, store: Store, host = "127.0.0.1"): Server {
  const server = createServer(async (req, res) => {
    try {
      if (!token) {
        res.writeHead(404);
        res.end();
        return;
      }
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const auth = req.headers.authorization?.replace(/^Bearer\s+/i, "");
      if (!tokenOk(auth, token)) {
        res.writeHead(401);
        res.end();
        return;
      }
      const m = /^\/admin\/switch\/([a-z]+)$/.exec(url.pathname);
      if (req.method !== "POST" || !m) {
        res.writeHead(404);
        res.end();
        return;
      }
      const name = m[1] as SwitchName | "global";
      const allowed = new Set(["consumption", "generation", "replies", "scout", "web", "proactive", "global"]);
      if (!allowed.has(name)) {
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
      await store.setSwitch(name, on);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ name, on }));
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
