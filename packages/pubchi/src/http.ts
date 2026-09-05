import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import {
  MemoryNonceStore,
  parseRequestObjectV1,
  verifyRequestObjectV1,
  type NonceStore,
  type TenantV1,
} from "../pubchi-schemas/index.js";
import { log } from "../bot-kit/log.js";
import {
  assertPubchiBindAllowed,
  parseBodyMaxBytes,
  parsePubchiPort,
  parseRequestTimeoutMs,
  pubchiBind,
  pubchiHttpBase,
  PUBCHI_HEADERS_TIMEOUT_MS,
  PUBCHI_MAX_CONNECTIONS,
} from "./env.js";
import { httpStatusFor, publicError, type ServiceErrorCode } from "./codes.js";
import type { TenantResolver } from "./tenant.js";
import type { TokenBudget, TokenBucket } from "./budget.js";
import type { QueryNlqFn, QueryOutcome } from "./query.js";
import { runQuery } from "./query.js";
import type { FeedOutcome } from "./feed.js";
import { runFeed } from "./feed.js";
import type { Brain } from "../bot-kit/brain/types.js";
import type { NlqServiceOptions } from "../bot-kit/nlq/service.js";

export {
  assertPubchiBindAllowed,
  isLoopbackBind,
  parsePubchiPort,
  pubchiBind,
  pubchiHttpBase,
} from "./env.js";

export type PubchiListenOptions = {
  port?: number;
  bind?: string;
  bodyMaxBytes?: number;
  requestTimeoutMs?: number;
  now?: () => number;
  nonceForAsker: (asker: string) => NonceStore;
  tenants: TenantResolver;
  budget: TokenBudget;
  bucket: TokenBucket;
  nlq: QueryNlqFn;
  nlqOpts: NlqServiceOptions;
  brain: Brain;
};

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
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

function writeError(res: ServerResponse, code: ServiceErrorCode): void {
  writeJson(res, httpStatusFor(code), publicError(code));
}

function runId(): string {
  return `run-${randomBytes(8).toString("hex")}`;
}

function payloadParts(raw: unknown): { request: unknown; body: unknown } | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  if (!("request" in rec)) return null;
  return { request: rec.request, body: rec.body };
}

export async function handlePubchiRequest(
  method: string,
  pathname: string,
  rawBody: string,
  opts: PubchiListenOptions,
): Promise<{ status: number; body: unknown }> {
  if (method === "GET" && pathname === "/healthz") {
    return { status: 200, body: { ok: true, role: "pubchi" } };
  }
  const isQuery = method === "POST" && pathname === "/v1/query";
  const isFeed = method === "POST" && pathname === "/v1/feed";
  if (!isQuery && !isFeed) {
    return { status: 404, body: publicError("SCHEMA_INVALID") };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody || "{}") as unknown;
  } catch {
    return { status: 400, body: publicError("SCHEMA_INVALID") };
  }
  const parts = payloadParts(parsed);
  if (!parts) return { status: 400, body: publicError("REQUEST_MALFORMED") };

  const shaped = parseRequestObjectV1(parts.request);
  if (!shaped.ok) return { status: httpStatusFor(shaped.code), body: publicError(shaped.code) };

  const enrolled = await opts.tenants.resolve(shaped.value.asker, shaped.value.bot);
  if (!enrolled.ok) return { status: httpStatusFor(enrolled.code), body: publicError(enrolled.code) };
  const tenant: TenantV1 = enrolled.tenant;

  const now = opts.now ? opts.now() : Math.floor(Date.now() / 1000);
  const verified = await verifyRequestObjectV1({
    request: parts.request,
    tenant,
    body: parts.body,
    now,
    nonces: opts.nonceForAsker(shaped.value.asker),
  });
  if (!verified.ok) return { status: httpStatusFor(verified.code), body: publicError(verified.code) };

  if (isQuery && verified.value.request.purpose !== "who-tagged-me") {
    return { status: 400, body: publicError("PURPOSE_UNSUPPORTED") };
  }
  if (isFeed && verified.value.request.purpose !== "build-feed") {
    return { status: 400, body: publicError("PURPOSE_UNSUPPORTED") };
  }

  if (!opts.bucket.take(tenant)) {
    return { status: httpStatusFor("BUDGET_EXCEEDED"), body: publicError("BUDGET_EXCEEDED") };
  }
  const budget = await opts.budget.check(tenant);
  if (!budget.ok) return { status: httpStatusFor(budget.code), body: publicError(budget.code) };

  let outcome: QueryOutcome | FeedOutcome;
  if (isQuery) {
    outcome = await runQuery({
      tenant,
      body: parts.body,
      now,
      runId: runId(),
      nlq: opts.nlq,
      nlqOpts: opts.nlqOpts,
    });
  } else {
    outcome = await runFeed({
      tenant,
      body: parts.body,
      now,
      brain: opts.brain,
    });
  }
  if (!outcome.ok) return { status: httpStatusFor(outcome.code), body: publicError(outcome.code) };
  const tokens = isFeed ? tenant.budgets.per_request_output_tokens : 1;
  await opts.budget.charge(tenant, tokens);
  return { status: 200, body: outcome.result };
}

export function listenPubchi(
  opts: PubchiListenOptions,
): Promise<{ server: Server; url: string; bind: string; port: number }> {
  const bind = pubchiBind(opts.bind);
  assertPubchiBindAllowed(bind);
  const port = opts.port ?? parsePubchiPort(process.env.PUBCHI_PORT);
  const bodyMax = opts.bodyMaxBytes ?? parseBodyMaxBytes(process.env.PUBCHI_BODY_MAX_BYTES);
  const timeoutMs = opts.requestTimeoutMs ?? parseRequestTimeoutMs(process.env.PUBCHI_REQUEST_TIMEOUT_MS);

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", pubchiHttpBase(bind));
      let raw: string;
      try {
        raw = await readBody(req, bodyMax);
      } catch {
        writeError(res, "REQUEST_MALFORMED");
        return;
      }
      const out = await handlePubchiRequest(req.method ?? "GET", url.pathname, raw, opts);
      writeJson(res, out.status, out.body);
    } catch (e) {
      log.warn({ err: e instanceof Error ? e.message : String(e) }, "pubchi http handler failed");
      writeError(res, "UPSTREAM_UNAVAILABLE");
    }
  });
  server.requestTimeout = timeoutMs;
  server.headersTimeout = PUBCHI_HEADERS_TIMEOUT_MS;
  server.maxConnections = PUBCHI_MAX_CONNECTIONS;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, bind, () => {
      const addr = server.address() as AddressInfo;
      resolve({
        server,
        bind,
        port: addr.port,
        url: pubchiHttpBase(bind, addr.port),
      });
    });
  });
}

export { MemoryNonceStore };
