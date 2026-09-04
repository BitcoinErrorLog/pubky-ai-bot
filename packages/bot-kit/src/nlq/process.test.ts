import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { IncomingMessage } from "node:http";
import { Store, switchOnSql } from "../../../../src/db.js";
import { configFromProcessEnv } from "../../../../src/config.js";
import { INTENT_REGEX_TABLES } from "../../../../src/intent.js";
import { log } from "../log.js";
import { ScoutClient } from "../scout/client.js";
import { listenNlq, nlqBind, nlqCallerKey, nlqMentionKey, parseNlqPort } from "./http.js";
import { runNlqProcess } from "./process.js";
import { startNlqScoutStub } from "./stub.js";
import { resetScoutSchemaCacheForTests } from "../scout/schema-cache.js";

const DB = process.env.DATABASE_URL ?? "postgres://johncarvalho@127.0.0.1:5432/jeb_stage1_test";
const store = new Store(DB);

beforeAll(async () => {
  process.env.DATABASE_URL ??= DB;
  await store.migrate();
});

afterEach(() => {
  resetScoutSchemaCacheForTests();
  delete process.env.PUBKY_BOT_SECRET_KEY_HEX;
  delete process.env.PUBKY_BOT_SECRET_KEY_FILE;
  delete process.env.PUBKY_BOT_MNEMONIC;
  delete process.env.JEB_NLQ_BIND_DANGEROUS;
  delete process.env.JEB_NLQ_TOKEN;
  vi.restoreAllMocks();
});

function fakeReq(opts: { auth?: string; addr?: string }): IncomingMessage {
  return {
    headers: opts.auth ? { authorization: opts.auth } : {},
    socket: { remoteAddress: opts.addr ?? "127.0.0.1" },
  } as IncomingMessage;
}

describe("nlq process posture", () => {
  it("defaults the HTTP bind to loopback", async () => {
    expect(nlqBind(undefined)).toBe("127.0.0.1");
    expect(nlqBind("")).toBe("127.0.0.1");
    expect(() => nlqBind("localhost")).toThrow(/invalid JEB_NLQ_BIND/);
    const stub = await startNlqScoutStub();
    const cfg = { ...configFromProcessEnv({ requireSecret: false }), scoutUrl: stub.url, scoutEnabled: true };
    const listening = await listenNlq({
      cfg,
      pool: store.pool,
      tables: INTENT_REGEX_TABLES,
      client: new ScoutClient(cfg, store.pool),
      port: 0,
    });
    const addr = listening.server.address();
    expect(addr && typeof addr === "object" ? addr.address : "").toBe("127.0.0.1");
    await new Promise<void>((resolve) => listening.server.close(() => resolve()));
    await new Promise<void>((resolve) => stub.server.close(() => resolve()));
  });

  it("refuses to start when PUBKY_BOT_* key material is present", async () => {
    process.env.PUBKY_BOT_SECRET_KEY_HEX = "ab".repeat(32);
    const stub = await startNlqScoutStub();
    const cfg = {
      ...configFromProcessEnv({ requireSecret: false }),
      scoutUrl: stub.url,
      scoutEnabled: true,
      nlqPort: 0,
    };
    await expect(runNlqProcess({ cfg, pool: store.pool, tables: INTENT_REGEX_TABLES })).rejects.toThrow(
      /key material must not be present/,
    );
    await new Promise<void>((resolve) => stub.server.close(() => resolve()));
  });

  it("refuses a non-loopback bind without JEB_NLQ_BIND_DANGEROUS", async () => {
    const stub = await startNlqScoutStub();
    const cfg = {
      ...configFromProcessEnv({ requireSecret: false }),
      scoutUrl: stub.url,
      scoutEnabled: true,
      nlqPort: 0,
      nlqBind: "8.8.8.8",
    };
    await expect(runNlqProcess({ cfg, pool: store.pool, tables: INTENT_REGEX_TABLES })).rejects.toThrow(
      /JEB_NLQ_BIND is not loopback/,
    );
    await new Promise<void>((resolve) => stub.server.close(() => resolve()));
  });

  it("starts on a non-loopback bind and warns when JEB_NLQ_BIND_DANGEROUS=1", async () => {
    process.env.JEB_NLQ_BIND_DANGEROUS = "1";
    const warn = vi.spyOn(log, "warn");
    const stub = await startNlqScoutStub();
    const cfg = {
      ...configFromProcessEnv({ requireSecret: false }),
      scoutUrl: stub.url,
      scoutEnabled: true,
      nlqPort: 0,
      nlqBind: "0.0.0.0",
    };
    const stop = await runNlqProcess({ cfg, pool: store.pool, tables: INTENT_REGEX_TABLES });
    expect(warn.mock.calls.some((c) => String(c[1] ?? c[0]).includes("non-loopback"))).toBe(true);
    await stop();
    await new Promise<void>((resolve) => stub.server.close(() => resolve()));
  });

  it("serves /healthz 200 on an IPv6 loopback bind", async () => {
    const stub = await startNlqScoutStub();
    const cfg = { ...configFromProcessEnv({ requireSecret: false }), scoutUrl: stub.url, scoutEnabled: true };
    const listening = await listenNlq({
      cfg,
      pool: store.pool,
      tables: INTENT_REGEX_TABLES,
      client: new ScoutClient(cfg, store.pool),
      port: 0,
      bind: "::1",
    });
    expect(listening.url.startsWith("http://[::1]:")).toBe(true);
    const res = await fetch(`${listening.url}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; role: string };
    expect(body).toMatchObject({ ok: true, role: "nlq" });
    await new Promise<void>((resolve) => listening.server.close(() => resolve()));
    await new Promise<void>((resolve) => stub.server.close(() => resolve()));
  });

  it("parses JEB_NLQ_PORT as an int in 1-65535 with a named error", () => {
    expect(parseNlqPort(undefined)).toBe(3014);
    expect(parseNlqPort("8080")).toBe(8080);
    expect(() => parseNlqPort("3014abc")).toThrow("invalid JEB_NLQ_PORT");
    expect(() => parseNlqPort("0")).toThrow("invalid JEB_NLQ_PORT");
    expect(() => parseNlqPort("65536")).toThrow("invalid JEB_NLQ_PORT");
  });

  it("maps nlqCallerKey match to nlq:token, mismatch to IP, and unwraps ::ffff:", () => {
    process.env.JEB_NLQ_TOKEN = "shared-nlq-token";
    expect(nlqMentionKey(nlqCallerKey(fakeReq({ auth: "Bearer shared-nlq-token" })))).toBe("nlq:token");
    expect(nlqMentionKey(nlqCallerKey(fakeReq({ auth: "Bearer wrong", addr: "10.1.2.3" })))).toBe("nlq:10.1.2.3");
    expect(nlqCallerKey(fakeReq({ addr: "::ffff:127.0.0.1" }))).toBe("127.0.0.1");
    expect(nlqMentionKey(nlqCallerKey(fakeReq({ addr: "::ffff:127.0.0.1" })))).toBe("nlq:127.0.0.1");
  });

  it("skips startup schema refresh and ticks while the scout switch is on", async () => {
    const stub = await startNlqScoutStub();
    await store.setSwitch("scout", true);
    try {
      const cfg = {
        ...configFromProcessEnv({ requireSecret: false }),
        scoutUrl: stub.url,
        scoutEnabled: true,
        scoutSchemaRefreshMs: 50,
        nlqPort: 0,
      };
      const stop = await runNlqProcess({
        cfg,
        pool: store.pool,
        tables: INTENT_REGEX_TABLES,
        storeSwitchOn: () => switchOnSql(store.pool, "scout"),
      });
      await new Promise((r) => setTimeout(r, 80));
      expect(stub.schemaGets).toBe(0);
      await stop();
    } finally {
      await store.setSwitch("scout", false);
      await new Promise<void>((resolve) => stub.server.close(() => resolve()));
    }
  });

  it("refuses a missing bearer with 403 unauthorized on a dangerous bind when the token is set", async () => {
    process.env.JEB_NLQ_BIND_DANGEROUS = "1";
    process.env.JEB_NLQ_TOKEN = "shared-nlq-token";
    const stub = await startNlqScoutStub();
    const cfg = { ...configFromProcessEnv({ requireSecret: false }), scoutUrl: stub.url, scoutEnabled: true };
    const listening = await listenNlq({
      cfg,
      pool: store.pool,
      tables: INTENT_REGEX_TABLES,
      client: new ScoutClient(cfg, store.pool),
      port: 0,
      bind: "0.0.0.0",
    });
    const queryUrl = `http://127.0.0.1:${listening.port}/v1/query`;
    const res = await fetch(queryUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "who follows anyone" }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { outcome: string; reason: string };
    expect(body).toMatchObject({ outcome: "unauthorized", reason: "unauthorized" });
    const wrong = await fetch(queryUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer nope" },
      body: JSON.stringify({ question: "who follows anyone" }),
    });
    expect(wrong.status).toBe(403);
    await new Promise<void>((resolve) => listening.server.close(() => resolve()));
    await new Promise<void>((resolve) => stub.server.close(() => resolve()));
  });

  it("serves loopback requests without a bearer even when JEB_NLQ_TOKEN is set", async () => {
    process.env.JEB_NLQ_TOKEN = "shared-nlq-token";
    const stub = await startNlqScoutStub();
    const cfg = { ...configFromProcessEnv({ requireSecret: false }), scoutUrl: stub.url, scoutEnabled: true };
    const listening = await listenNlq({
      cfg,
      pool: store.pool,
      tables: INTENT_REGEX_TABLES,
      client: new ScoutClient(cfg, store.pool),
      port: 0,
      bind: "127.0.0.1",
    });
    const res = await fetch(`${listening.url}/v1/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "who follows anyone" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { outcome: string };
    expect(body.outcome).not.toBe("unauthorized");
    await new Promise<void>((resolve) => listening.server.close(() => resolve()));
    await new Promise<void>((resolve) => stub.server.close(() => resolve()));
  });
});
