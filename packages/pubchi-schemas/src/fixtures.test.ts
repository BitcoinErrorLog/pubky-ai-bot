import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ERROR_CODES, type ErrorCode } from "./codes.js";
import { MemoryNonceStore } from "./nonce.js";
import { parseBySchema } from "./parse.js";
import { parseRequestObjectV1, verifyRequestObjectV1 } from "./request.js";
import type { TenantV1 } from "./tenant.js";

const fixturesRoot = join(dirname(fileURLToPath(import.meta.url)), "../fixtures");

type Meta = {
  verify?: boolean;
  now?: number;
  body?: unknown;
  tenant?: TenantV1;
  replay_nonce?: boolean;
};

function listJson(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json") && !name.endsWith(".meta.json") && !name.startsWith("._"))
    .sort();
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readMeta(dir: string, file: string): Meta | undefined {
  const metaPath = join(dir, file.replace(/\.json$/, ".meta.json"));
  try {
    return readJson(metaPath) as Meta;
  } catch {
    return undefined;
  }
}

function expectedCode(file: string): ErrorCode {
  const match = file.match(/__([A-Z0-9_]+)__/);
  if (!match || !ERROR_CODES.includes(match[1] as ErrorCode)) {
    throw new Error(`invalid fixture filename (missing error code): ${file}`);
  }
  return match[1] as ErrorCode;
}

async function runVerify(object: unknown, meta: Meta): Promise<ErrorCode | "ok"> {
  if (!meta.tenant || meta.body === undefined || meta.now === undefined) {
    throw new Error("verifier fixture is missing tenant/body/now");
  }
  const parsed = parseRequestObjectV1(object);
  if (!parsed.ok) return parsed.code;
  const nonces = new MemoryNonceStore();
  if (meta.replay_nonce) {
    nonces.seed(parsed.value.bot, parsed.value.nonce, parsed.value.expires_at);
  }
  const verified = await verifyRequestObjectV1({
    request: object,
    tenant: meta.tenant,
    body: meta.body,
    now: meta.now,
    nonces,
  });
  return verified.ok ? "ok" : verified.code;
}

describe("fixture walk", () => {
  const validDir = join(fixturesRoot, "valid");
  const invalidDir = join(fixturesRoot, "invalid");
  const validFiles = listJson(validDir);
  const invalidFiles = listJson(invalidDir);

  it("has both valid and invalid fixtures", () => {
    expect(validFiles.length).toBeGreaterThan(0);
    expect(invalidFiles.length).toBeGreaterThan(0);
  });

  it.each(validFiles)("parses valid/%s", async (file) => {
    const object = readJson(join(validDir, file));
    const parsed = parseBySchema(object);
    expect(parsed.ok, `${file} should parse`).toBe(true);
    const meta = readMeta(validDir, file);
    if (meta?.verify) {
      expect(await runVerify(object, meta)).toBe("ok");
    }
  });

  it.each(invalidFiles)("rejects invalid/%s", async (file) => {
    const object = readJson(join(invalidDir, file));
    const code = expectedCode(file);
    const meta = readMeta(invalidDir, file);
    if (meta?.verify) {
      expect(await runVerify(object, meta)).toBe(code);
      return;
    }
    const parsed = parseBySchema(object);
    expect(parsed.ok, `${file} should fail`).toBe(false);
    if (!parsed.ok) expect(parsed.code).toBe(code);
  });
});
