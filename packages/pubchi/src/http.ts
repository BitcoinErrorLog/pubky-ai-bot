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
  corsAllowHeaders,
  corsHeadersForOrigin,
  parseAllowedOrigins,
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

export type PubchiStage = "verify" | "tenant" | "query" | "feed" | "upstream";

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

export type PubchiHandlerResult = {
  status: number;
  body: unknown;
  stage?: PubchiStage;
  cause?: string;
  upstream_host?: string;
  upstream_status?: number;
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

function requestOrigin(req: IncomingMessage): string | undefined {
  const raw = req.headers.origin;
  if (typeof raw === "string" && raw.length > 0) return raw;
  return undefined;
}

function mergeHeaders(cors: Record<string, string> | null, extra?: Record<string, string>): Record<string, string> {
  return { ...(cors ?? {}), ...(extra ?? {}) };
}

function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extra?: Record<string, string>,
): void {
  res.writeHead(status, { "content-type": "application/json", ...extra });
  res.end(JSON.stringify(body));
}

function writeError(res: ServerResponse, code: ServiceErrorCode, extra?: Record<string, string>): void {
  writeJson(res, httpStatusFor(code), publicError(code), extra);
}

function writePreflight(res: ServerResponse, cors: Record<string, string> | null): void {
  if (cors) {
    res.writeHead(204, {
      ...cors,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": corsAllowHeaders(),
      "Access-Control-Max-Age": "600",
    });
  } else {
    res.writeHead(204);
  }
  res.end();
}

function sanitizeCause(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value
    .replace(/[0-9a-f]{64}/gi, "[hex]")
    .replace(/postgres:\/\/\S+/gi, "[db]")
    .replace(/Bearer\s+\S+/gi, "[token]")
    .replace(/pubky:\/\/[a-z0-9]{52}/gi, "pubky://[id]")
    .slice(0, 160);
}

export function logNon2xx(opts: {
  code: string;
  stage: PubchiStage;
  status: number;
  cause?: string;
  upstream_host?: string;
  upstream_status?: number;
}): void {
  const payload: Record<string, unknown> = {
    code: opts.code,
    stage: opts.stage,
    status: opts.status,
  };
  const cause = sanitizeCause(opts.cause);
  if (cause) payload.cause = cause;
  if (opts.upstream_host) payload.upstream_host = opts.upstream_host;
  if (opts.upstream_status !== undefined) payload.upstream_status = opts.upstream_status;
  log.warn(payload, "pubchi non-2xx");
}

function fail(
  code: ServiceErrorCode,
  stage: PubchiStage,
  cause?: string,
  extra?: { upstream_host?: string; upstream_status?: number },
): PubchiHandlerResult {
  const status = httpStatusFor(code);
  logNon2xx({ code, stage, status, cause, ...extra });
  return { status, body: publicError(code), stage, cause, ...extra };
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
): Promise<PubchiHandlerResult> {
  if (method === "GET" && pathname === "/healthz") {
    return { status: 200, body: { ok: true, role: "pubchi" } };
  }
  const isQuery = method === "POST" && pathname === "/v1/query";
  const isFeed = method === "POST" && pathname === "/v1/feed";
  if (!isQuery && !isFeed) {
    return fail("SCHEMA_INVALID", "verify", "unknown_path");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody || "{}") as unknown;
  } catch {
    return fail("SCHEMA_INVALID", "verify", "json_parse");
  }
  const parts = payloadParts(parsed);
  if (!parts) return fail("REQUEST_MALFORMED", "verify", "missing_request");

  const shaped = parseRequestObjectV1(parts.request);
  if (!shaped.ok) return fail(shaped.code, "verify", shaped.code);

  const enrolled = await opts.tenants.resolve(shaped.value.asker, shaped.value.bot);
  if (!enrolled.ok) {
    const stage: PubchiStage = enrolled.code === "UPSTREAM_UNAVAILABLE" ? "upstream" : "tenant";
    return fail(enrolled.code, stage, enrolled.code);
  }
  const tenant: TenantV1 = enrolled.tenant;

  const now = opts.now ? opts.now() : Math.floor(Date.now() / 1000);
  const verified = await verifyRequestObjectV1({
    request: parts.request,
    tenant,
    body: parts.body,
    now,
    nonces: opts.nonceForAsker(shaped.value.asker),
  });
  if (!verified.ok) return fail(verified.code, "verify", verified.code);

  if (isQuery && verified.value.request.purpose !== "who-tagged-me") {
    return fail("PURPOSE_UNSUPPORTED", "verify", "purpose");
  }
  if (isFeed && verified.value.request.purpose !== "build-feed") {
    return fail("PURPOSE_UNSUPPORTED", "verify", "purpose");
  }

  if (!opts.bucket.take(tenant)) {
    return fail("BUDGET_EXCEEDED", "query", "bucket");
  }
  const budget = await opts.budget.check(tenant);
  if (!budget.ok) return fail(budget.code, "query", budget.code);

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
  if (!outcome.ok) {
    const stage: PubchiStage =
      "stage" in outcome && outcome.stage ? outcome.stage : isQuery ? "query" : "feed";
    const cause = "cause" in outcome && typeof outcome.cause === "string" ? outcome.cause : outcome.code;
    const hostMatch = / ([a-z0-9.-]+)$/i.exec(cause);
    return fail(outcome.code, stage, cause, hostMatch ? { upstream_host: hostMatch[1] } : undefined);
  }
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
  const allowedOrigins = parseAllowedOrigins();

  const server = createServer(async (req, res) => {
    const cors = corsHeadersForOrigin(requestOrigin(req), allowedOrigins);
    try {
      if ((req.method ?? "GET").toUpperCase() === "OPTIONS") {
        writePreflight(res, cors);
        return;
      }
      const url = new URL(req.url ?? "/", pubchiHttpBase(bind));
      let raw: string;
      try {
        raw = await readBody(req, bodyMax);
      } catch {
        logNon2xx({ code: "REQUEST_MALFORMED", stage: "verify", status: 400, cause: "body_too_large" });
        writeError(res, "REQUEST_MALFORMED", mergeHeaders(cors));
        return;
      }
      const out = await handlePubchiRequest(req.method ?? "GET", url.pathname, raw, opts);
      writeJson(res, out.status, out.body, mergeHeaders(cors));
    } catch (e) {
      const cause = e instanceof Error ? e.name : "handler";
      logNon2xx({ code: "UPSTREAM_UNAVAILABLE", stage: "upstream", status: 503, cause });
      writeError(res, "UPSTREAM_UNAVAILABLE", mergeHeaders(cors));
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
