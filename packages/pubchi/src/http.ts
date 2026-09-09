import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import {
  MemoryNonceStore,
  parseRequestObjectV1,
  verifySignedRequestObjectV1,
  type NonceStore,
  type TenantV1,
} from "../pubchi-schemas/index.js";
import { log } from "../bot-kit/log.js";
import {
  assertPubchiBindAllowed,
  clientAddress,
  corsAllowHeaders,
  corsHeadersForOrigin,
  parseAllowedOrigins,
  parseBodyMaxBytes,
  parsePreauthBurst,
  parsePreauthIpBurst,
  parsePreauthIpRps,
  parsePreauthRps,
  parsePubchiPort,
  parseRequestTimeoutMs,
  parseRequireDeviceSigner,
  parseTrustProxy,
  pubchiBind,
  pubchiHttpBase,
  PUBCHI_HEADERS_TIMEOUT_MS,
  PUBCHI_MAX_CONNECTIONS,
} from "./env.js";
import { httpStatusFor, publicError, type ServiceErrorCode } from "./codes.js";
import type { DelegationResolve, TenantResolver } from "./tenant.js";
import type { TokenBudget, TokenBucket } from "./budget.js";
import { memoryPreauthLimiter, type PreauthLimiter } from "./preauth.js";
import type { QueryNlqFn, QueryNexus, QueryOutcome } from "./query.js";
import { runQuery } from "./query.js";
import type { FeedOutcome } from "./feed.js";
import { runFeed } from "./feed.js";
import type { AskOutcome } from "./ask.js";
import { runAsk } from "./ask.js";
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
export type PubchiMode = "runtime";

export type PubchiListenOptions = {
  mode: PubchiMode;
  port?: number;
  bind?: string;
  bodyMaxBytes?: number;
  requestTimeoutMs?: number;
  now?: () => number;
  nonceForAsker: (asker: string) => NonceStore;
  tenants: TenantResolver;
  budget: TokenBudget;
  bucket: TokenBucket;
  preauth?: PreauthLimiter;
  trustProxy?: boolean;
  requireDeviceSigner?: boolean;
  nlq: QueryNlqFn;
  nlqOpts: NlqServiceOptions;
  nexus: QueryNexus;
  brain: Brain;
  feedSwitchOn?: () => Promise<boolean>;
  readiness?: () => Promise<{ config: boolean; database: boolean; migrations: boolean }>;
};

export type PubchiHandlerResult = {
  status: number;
  body: unknown;
  stage?: PubchiStage;
  cause?: string;
  upstream_host?: string;
  upstream_status?: number;
  headers?: Record<string, string>;
};

type TimingStages = Record<string, number>;
type TimingCache = { tenant: "hit" | "miss"; delegation: "hit" | "miss" };

function serverTiming(stages: TimingStages): string {
  return Object.entries(stages)
    .map(([name, ms]) => `${name};dur=${ms}`)
    .join(", ");
}

function finishTiming(
  result: PubchiHandlerResult,
  started: number,
  stages: TimingStages,
  purpose: string,
  cache: TimingCache,
): PubchiHandlerResult {
  const serializeStarted = performance.now();
  JSON.stringify(result.body);
  stages.response_serialize = Math.round(performance.now() - serializeStarted);
  stages.total = Math.round(performance.now() - started);
  const completeStages: TimingStages = {
    body_parse_schema: 0,
    signature_verify: 0,
    tenant_resolve: 0,
    delegation_resolve: 0,
    nonce_consume: 0,
    budget_reserve: 0,
    handler: 0,
    response_serialize: 0,
    total: 0,
    ...stages,
  };
  log.info(
    { event: "pubchi_request_timing", purpose, status: result.status, stages: completeStages, cache },
    "pubchi request timing",
  );
  if (result.status < 200 || result.status >= 300) return result;
  return { ...result, headers: { ...(result.headers ?? {}), "Server-Timing": serverTiming(completeStages) } };
}

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

function payloadParts(raw: unknown): { request: unknown; body: unknown; bodyPresent: boolean } | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  if (!("request" in rec)) return null;
  return {
    request: rec.request,
    body: rec.body === undefined ? null : rec.body,
    bodyPresent: Object.prototype.hasOwnProperty.call(rec, "body"),
  };
}

function isVerifyTypeError(err: unknown): boolean {
  return err instanceof TypeError || err instanceof RangeError;
}

export async function handlePubchiRequest(
  method: string,
  pathname: string,
  rawBody: string,
  opts: PubchiListenOptions,
): Promise<PubchiHandlerResult> {
  if (method === "GET" && (pathname === "/healthz" || pathname === "/health")) {
    const readiness = opts.readiness ? await opts.readiness() : { config: true, database: true, migrations: true };
    const ok = readiness.config && readiness.database && readiness.migrations;
    return { status: ok ? 200 : 503, body: { ok, role: "pubchi", mode: opts.mode, ...readiness } };
  }
  const isQuery = method === "POST" && pathname === "/v1/query";
  const isFeed = method === "POST" && pathname === "/v1/feed";
  if (!isQuery && !isFeed) {
    return fail("PATH_FORBIDDEN", "verify", "unknown_path");
  }

  const started = performance.now();
  const stages: TimingStages = {};
  let purpose = "unknown";
  let cache: TimingCache = { tenant: "miss", delegation: "miss" };
  const finish = (result: PubchiHandlerResult, handlerTimings?: Record<string, number>) => {
    if (handlerTimings) Object.assign(stages, handlerTimings);
    return finishTiming(result, started, stages, purpose, cache);
  };
  const bodyStarted = performance.now();
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody || "{}") as unknown;
  } catch {
    stages.body_parse_schema = Math.round(performance.now() - bodyStarted);
    return finish(fail("SCHEMA_INVALID", "verify", "json_parse"));
  }
  const parts = payloadParts(parsed);
  stages.body_parse_schema = Math.round(performance.now() - bodyStarted);
  if (!parts) return finish(fail("REQUEST_MALFORMED", "verify", "missing_request"));
  if (!parts.bodyPresent) return finish(fail("SCHEMA_INVALID", "verify", "missing_body"));

  const now = opts.now ? opts.now() : Math.floor(Date.now() / 1000);
  let verified;
  const verifyStarted = performance.now();
  try {
    const shaped = parseRequestObjectV1(parts.request);
    if (!shaped.ok) return finish(fail(shaped.code, "verify", shaped.code));
    verified = await verifySignedRequestObjectV1({
      request: parts.request,
      body: parts.body,
      now,
      nonces: opts.nonceForAsker(shaped.value.asker),
      consumeNonce: false,
    });
  } catch (e) {
    stages.signature_verify = Math.round(performance.now() - verifyStarted);
    if (isVerifyTypeError(e)) return finish(fail("SCHEMA_INVALID", "verify", e instanceof Error ? e.name : "verify_type"));
    throw e;
  }
  stages.signature_verify = Math.round(performance.now() - verifyStarted);
  if (!verified.ok) return finish(fail(verified.code, "verify", verified.code));
  const request = verified.value;
  purpose = request.purpose;

  const requireDeviceSigner =
    opts.requireDeviceSigner ?? parseRequireDeviceSigner(process.env.PUBCHI_REQUIRE_DEVICE_SIGNER);
  if (requireDeviceSigner && !request.signer) {
    return finish(fail("UNAUTHORIZED", "verify", "device_signer_required"));
  }

  // Until a device signer is proven authorized by a verified delegation, every
  // post-signature authorization failure collapses into one opaque code so an
  // attacker-minted signer cannot tell "not enrolled" from "wrong bot" from
  // "no delegation". The precise reason stays in the server-side log (cause).
  const cacheStatus = opts.tenants.cacheStatus?.(request.asker, request.bot, request.signer);
  cache = cacheStatus ?? cache;
  const tenantStarted = performance.now();
  const delegationPromise = request.signer
    ? opts.tenants
        .resolveDelegation(request.asker, request.signer, request.bot, request.purpose, now)
        .catch((e): DelegationResolve => {
          const name = e instanceof Error ? e.name : "delegation_prefetch_threw";
          log.warn({ event: "pubchi_delegation_prefetch_failed", name }, "pubchi delegation prefetch failed");
          return { ok: false, code: "UPSTREAM_UNAVAILABLE", cause: "delegation_prefetch_threw" };
        })
    : null;
  const enrolled = await opts.tenants.resolve(request.asker, request.bot);
  stages.tenant_resolve = Math.round(performance.now() - tenantStarted);
  if (!enrolled.ok) {
    if (enrolled.code === "UPSTREAM_UNAVAILABLE") {
      return finish(fail("UPSTREAM_UNAVAILABLE", "upstream", enrolled.cause ?? enrolled.code, {
        upstream_host: enrolled.upstream_host,
        upstream_status: enrolled.upstream_status,
      }));
    }
    if (request.signer) return finish(fail("UNAUTHORIZED", "tenant", `enrollment:${enrolled.code}`));
    return finish(fail(enrolled.code, "tenant", enrolled.cause ?? enrolled.code));
  }
  const tenant: TenantV1 = enrolled.tenant;
  if (request.asker !== tenant.owner) {
    if (request.signer) return finish(fail("UNAUTHORIZED", "verify", "enrollment:ASKER_MISMATCH"));
    return finish(fail("ASKER_MISMATCH", "verify", "asker"));
  }
  if (request.bot !== tenant.bot) {
    if (request.signer) return finish(fail("UNAUTHORIZED", "verify", "enrollment:BOT_MISMATCH"));
    return finish(fail("BOT_MISMATCH", "verify", "bot"));
  }

  if (request.signer) {
    const delegationStarted = performance.now();
    const delegation = await delegationPromise!;
    stages.delegation_resolve = Math.round(performance.now() - delegationStarted);
    if (!delegation.ok) {
      if (delegation.code === "UPSTREAM_UNAVAILABLE") {
        return finish(fail("UPSTREAM_UNAVAILABLE", "upstream", delegation.cause ?? delegation.code, {
          upstream_host: delegation.upstream_host,
          upstream_status: delegation.upstream_status,
        }));
      }
      return finish(fail("UNAUTHORIZED", "verify", `delegation:${delegation.code}`));
    }
  }

  if (isQuery && request.purpose !== "who-tagged-me" && request.purpose !== "ask") {
    return finish(fail("PURPOSE_UNSUPPORTED", "verify", "purpose"));
  }
  if (isFeed && request.purpose !== "build-feed") {
    return finish(fail("PURPOSE_UNSUPPORTED", "verify", "purpose"));
  }

  const nonceStarted = performance.now();
  let first: boolean;
  try {
    first = await opts.nonceForAsker(request.asker).consume(request.bot, request.nonce, request.expires_at);
  } catch (e) {
    stages.nonce_consume = Math.round(performance.now() - nonceStarted);
    if (isVerifyTypeError(e)) return finish(fail("SCHEMA_INVALID", "verify", e instanceof Error ? e.name : "nonce_type"));
    throw e;
  }
  stages.nonce_consume = Math.round(performance.now() - nonceStarted);
  if (!first) return finish(fail("NONCE_REPLAY", "verify", "nonce"));

  if (isFeed && opts.feedSwitchOn && (await opts.feedSwitchOn())) {
    return finish(fail("FEED_DISABLED", "feed", "feed_switch"));
  }

  if (!opts.bucket.take(tenant)) {
    return finish(fail("BUDGET_EXCEEDED", "query", "bucket"));
  }
  const tokens = isFeed || (isQuery && request.purpose === "ask") ? tenant.budgets.per_request_output_tokens : 1;
  const budgetStarted = performance.now();
  const reserved = await opts.budget.reserve(tenant, tokens);
  stages.budget_reserve = Math.round(performance.now() - budgetStarted);
  if (!reserved.ok) return finish(fail(reserved.code, "query", reserved.code));

  let outcome: QueryOutcome | FeedOutcome | AskOutcome;
  const handlerStarted = performance.now();
  try {
    if (isQuery && request.purpose === "ask") {
      outcome = await runAsk({
        tenant,
        body: parts.body,
        now,
        runId: runId(),
        nlq: opts.nlq,
        nlqOpts: opts.nlqOpts,
        nexus: opts.nexus,
        brain: opts.brain,
      });
    } else if (isQuery) {
      outcome = await runQuery({
        tenant,
        body: parts.body,
        now,
        runId: runId(),
        nlq: opts.nlq,
        nlqOpts: opts.nlqOpts,
        nexus: opts.nexus,
      });
    } else {
      outcome = await runFeed({
        tenant,
        body: parts.body,
        now,
        brain: opts.brain,
      });
    }
  } catch (e) {
    await opts.budget.refund(reserved.reservation);
    throw e;
  }
  if (!outcome.ok) {
    await opts.budget.refund(reserved.reservation);
    const stage: PubchiStage =
      "stage" in outcome && outcome.stage ? outcome.stage : isQuery ? "query" : "feed";
    const cause = "cause" in outcome && typeof outcome.cause === "string" ? outcome.cause : outcome.code;
    const hostMatch = / ([a-z0-9._-]+(?::\d+)?)$/i.exec(cause);
    stages.handler = Math.round(performance.now() - handlerStarted);
    return finish(fail(outcome.code, stage, cause, hostMatch ? { upstream_host: hostMatch[1] } : undefined), outcome.timings);
  }
  let settlement = reserved.reservation;
  if ("settlementTokens" in outcome && outcome.settlementTokens !== undefined && outcome.settlementTokens < settlement.tokens) {
    settlement = await opts.budget.resize(settlement, outcome.settlementTokens);
  }
  await opts.budget.settle(settlement);
  stages.handler = Math.round(performance.now() - handlerStarted);
  return finish({ status: 200, body: outcome.result }, outcome.timings);
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
  const trustProxy = opts.trustProxy ?? parseTrustProxy();
  const preauth =
    opts.preauth ??
    memoryPreauthLimiter({
      globalRps: parsePreauthRps(process.env.PUBCHI_PREAUTH_RPS),
      globalBurst: parsePreauthBurst(process.env.PUBCHI_PREAUTH_BURST),
      ipRps: parsePreauthIpRps(process.env.PUBCHI_PREAUTH_IP_RPS),
      ipBurst: parsePreauthIpBurst(process.env.PUBCHI_PREAUTH_IP_BURST),
    });

  const server = createServer(async (req, res) => {
    const cors = corsHeadersForOrigin(requestOrigin(req), allowedOrigins);
    try {
      if ((req.method ?? "GET").toUpperCase() === "OPTIONS") {
        writePreflight(res, cors);
        return;
      }
      const url = new URL(req.url ?? "/", pubchiHttpBase(bind));
      const method = (req.method ?? "GET").toUpperCase();
      const addr = clientAddress({
        remoteAddress: req.socket.remoteAddress,
        forwardedFor: req.headers["x-forwarded-for"],
        trustProxy,
      });
      if (!preauth.take(addr)) {
        logNon2xx({ code: "RATE_LIMITED", stage: "verify", status: 429, cause: "preauth" });
        writeError(res, "RATE_LIMITED", mergeHeaders(cors));
        return;
      }
      let raw: string;
      try {
        raw = await readBody(req, bodyMax);
      } catch {
        logNon2xx({ code: "REQUEST_MALFORMED", stage: "verify", status: 400, cause: "body_too_large" });
        writeError(res, "REQUEST_MALFORMED", mergeHeaders(cors));
        return;
      }
      const out = await handlePubchiRequest(method, url.pathname, raw, opts);
      writeJson(res, out.status, out.body, mergeHeaders(cors, out.headers));
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
