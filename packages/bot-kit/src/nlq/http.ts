import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { log } from "../log.js";
import { schemaHealthSnapshot } from "../scout/schema-cache.js";
import {
  assertNlqBindAllowed,
  isLoopbackBind,
  nlqBind,
  nlqHttpBase,
  parseNlqPort,
} from "./env.js";
import { queryNlq, type NlqServiceOptions } from "./service.js";
import { nlqResult, type NlqRequest } from "./types.js";

export {
  assertNlqBindAllowed,
  isLoopbackBind,
  nlqBind,
  nlqHttpBase,
  parseNlqDailyQueries,
  parseNlqPort,
} from "./env.js";

/** Bound slowloris on an optionally internet-facing process (audit A4 F-12). */
export const NLQ_REQUEST_TIMEOUT_MS = 30_000;
export const NLQ_HEADERS_TIMEOUT_MS = 10_000;
export const NLQ_MAX_CONNECTIONS = 128;

export type NlqListenOptions = NlqServiceOptions & {
  port?: number;
  bind?: string;
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBearer(req: IncomingMessage): string {
  const header = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
}

function tokenEquals(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

/** True when the request Bearer matches JEB_NLQ_TOKEN. Never logs the token. */
export function nlqBearerMatches(req: IncomingMessage): boolean {
  const configured = process.env.JEB_NLQ_TOKEN?.trim();
  if (!configured) return false;
  const bearer = readBearer(req);
  if (!bearer) return false;
  return tokenEquals(bearer, configured);
}

/** Caller identity for budgets. Never returns or logs JEB_NLQ_TOKEN. */
export function nlqCallerKey(req: IncomingMessage): string {
  if (nlqBearerMatches(req)) return "token";
  const addr = req.socket.remoteAddress ?? "unknown";
  return addr.startsWith("::ffff:") ? addr.slice("::ffff:".length) : addr;
}

/** Token is required auth only when set and the bind is non-loopback. */
export function nlqRequiresBearer(bind: string): boolean {
  return Boolean(process.env.JEB_NLQ_TOKEN?.trim()) && !isLoopbackBind(bind);
}

export function nlqMentionKey(callerKey: string): string {
  return `nlq:${callerKey}`;
}

export function listenNlq(opts: NlqListenOptions): Promise<{ server: Server; url: string; bind: string; port: number }> {
  const bind = nlqBind(opts.bind);
  assertNlqBindAllowed(bind);
  const port = opts.port ?? parseNlqPort(process.env.JEB_NLQ_PORT);
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", nlqHttpBase(bind));
      if (req.method === "GET" && url.pathname === "/healthz") {
        writeJson(res, 200, { ok: true, role: "nlq", scoutSchema: schemaHealthSnapshot() });
        return;
      }
      if (req.method === "POST" && (url.pathname === "/v1/query" || url.pathname === "/query")) {
        if (nlqRequiresBearer(bind) && !nlqBearerMatches(req)) {
          writeJson(res, 403, nlqResult({ outcome: "unauthorized", reason: "unauthorized", intent: "ignore" }));
          req.resume();
          return;
        }
        let raw: string;
        try {
          raw = await readBody(req);
        } catch {
          writeJson(
            res,
            400,
            nlqResult({ outcome: "unsupported", reason: "request body too large or unreadable", intent: "ignore" }),
          );
          return;
        }
        let body: NlqRequest;
        try {
          body = JSON.parse(raw || "{}") as NlqRequest;
        } catch {
          writeJson(res, 400, nlqResult({ outcome: "unsupported", reason: "invalid JSON", intent: "ignore" }));
          return;
        }
        if (typeof body.question !== "string") {
          writeJson(res, 400, nlqResult({ outcome: "unsupported", reason: "question is required", intent: "ignore" }));
          return;
        }
        const mentionKey = opts.mentionKey ?? nlqMentionKey(nlqCallerKey(req));
        const result = await queryNlq(body, { ...opts, mentionKey });
        writeJson(res, 200, result);
        return;
      }
      writeJson(res, 404, nlqResult({ outcome: "unsupported", reason: "not found", intent: "ignore" }));
    } catch (e) {
      log.warn({ err: e instanceof Error ? e.message : String(e) }, "nlq http handler failed");
      writeJson(
        res,
        200,
        nlqResult({
          outcome: "tool_error",
          reason: "internal error",
          intent: "answer",
        }),
      );
    }
  });
  server.requestTimeout = NLQ_REQUEST_TIMEOUT_MS;
  server.headersTimeout = NLQ_HEADERS_TIMEOUT_MS;
  server.maxConnections = NLQ_MAX_CONNECTIONS;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, bind, () => {
      const addr = server.address() as AddressInfo;
      resolve({
        server,
        bind,
        port: addr.port,
        url: nlqHttpBase(bind, addr.port),
      });
    });
  });
}
