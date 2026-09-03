import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { skipEmbeddingWarmup } from "../../src/knowledge/embed.js";
import { createSearchKnowledgeExecute } from "../../src/knowledge/tool.js";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const distMain = path.join(repoRoot, "dist", "main.js");

describe("skipEmbeddingWarmup", () => {
  const prevContract = process.env.JEB_CONTRACT_MODE;
  const prevCanned = process.env.JEB_CANNED_REPLY;

  afterEach(() => {
    if (prevContract === undefined) delete process.env.JEB_CONTRACT_MODE;
    else process.env.JEB_CONTRACT_MODE = prevContract;
    if (prevCanned === undefined) delete process.env.JEB_CANNED_REPLY;
    else process.env.JEB_CANNED_REPLY = prevCanned;
  });

  it("is true in contract mode and when a canned reply is set", () => {
    delete process.env.JEB_CONTRACT_MODE;
    delete process.env.JEB_CANNED_REPLY;
    expect(skipEmbeddingWarmup()).toBe(false);
    process.env.JEB_CONTRACT_MODE = "1";
    expect(skipEmbeddingWarmup()).toBe(true);
    delete process.env.JEB_CONTRACT_MODE;
    process.env.JEB_CANNED_REPLY = "hello";
    expect(skipEmbeddingWarmup()).toBe(true);
  });
});

describe("search_knowledge missing cache", () => {
  const prevLocal = process.env.JEB_MODEL_LOCAL_ONLY;
  const prevCache = process.env.JEB_MODEL_CACHE;

  afterEach(() => {
    if (prevLocal === undefined) delete process.env.JEB_MODEL_LOCAL_ONLY;
    else process.env.JEB_MODEL_LOCAL_ONLY = prevLocal;
    if (prevCache === undefined) delete process.env.JEB_MODEL_CACHE;
    else process.env.JEB_MODEL_CACHE = prevCache;
  });

  it("returns a typed knowledge unavailable tool error", async () => {
    process.env.JEB_MODEL_LOCAL_ONLY = "1";
    process.env.JEB_MODEL_CACHE = path.join(os.tmpdir(), `jeb-no-models-${Date.now()}`);
    const url = process.env.JEB_KNOWLEDGE_TEST_DATABASE_URL?.trim() || "postgres://johncarvalho@127.0.0.1:5432/jeb_knowledge_unit";
    const pool = new pg.Pool({ connectionString: url, max: 2 });
    try {
      const { execute } = createSearchKnowledgeExecute({ pool });
      const out = await execute({ query: "ports" });
      expect(out).toEqual({
        error: "knowledge unavailable",
        reason: expect.stringMatching(/embedding model missing/),
      });
    } finally {
      await pool.end();
    }
  });
});

describe("reason role contract spawn", () => {
  it("stays alive for 5s and logs started without a model cache", async () => {
    if (!fs.existsSync(distMain)) return;
    const missingCache = path.join(os.tmpdir(), `jeb-missing-cache-${Date.now()}`);
    const logs: string[] = [];
    const child = spawn(process.execPath, [distMain, "--role", "reason"], {
      env: {
        ...process.env,
        JEB_CONTRACT_MODE: "1",
        JEB_CANNED_REPLY: "contract",
        JEB_MODEL_CACHE: missingCache,
        JEB_MODEL_LOCAL_ONLY: "1",
        JEB_SKIP_MIGRATIONS: "1",
        JEB_BOT_PK: "b".repeat(52),
        DATABASE_URL:
          process.env.JEB_KNOWLEDGE_TEST_DATABASE_URL ||
          "postgres://johncarvalho@127.0.0.1:5432/jeb_knowledge_unit",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const onData = (buf: Buffer) => logs.push(buf.toString("utf8"));
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    let exited = false;
    child.once("exit", () => {
      exited = true;
    });
    await new Promise((r) => setTimeout(r, 5_000));
    const text = logs.join("");
    expect(exited, text).toBe(false);
    expect(text).toMatch(/started/);
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 15_000);
});
