import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configFromProcessEnv } from "./config.js";
import { runResourcesCli } from "./resources.js";

beforeEach(() => {
  delete process.env.PUBKY_BOT_SECRET_KEY_HEX;
  delete process.env.PUBKY_BOT_SECRET_KEY_FILE;
  delete process.env.PUBKY_BOT_MNEMONIC;
  delete process.env.JEB_RESOURCE_TARGET;
  delete process.env.JEB_RESOURCE_MODE;
});

afterEach(() => {
  delete process.env.JEB_RESOURCE_TARGET;
  delete process.env.JEB_RESOURCE_MODE;
  delete process.env.PUBKY_BOT_SECRET_KEY_HEX;
  delete process.env.PUBKY_BOT_SECRET_KEY_FILE;
  delete process.env.PUBKY_BOT_MNEMONIC;
});

describe("resources CLI boundary", () => {
  it("reads a real JSON input file and preserves the shadow-only boundary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jeb-resources-"));
    const path = join(directory, "resources.json");
    try {
      await writeFile(path, JSON.stringify([{ family: "url", value: "https://example.test/docs", source: "test", labels: ["documentation"] }]));
      const result = await runResourcesCli(configFromProcessEnv({ requireSecret: false, role: "resources" }), [
        "node",
        "main.js",
        "--role",
        "resources",
        "discover",
        "--input",
        path,
        "--limit",
        "1",
      ]);
      expect(result.ok).toBe(true);
      expect(JSON.parse(result.lines[0]!).mode).toBe("shadow");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects an input file above the byte ceiling before parsing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jeb-resources-"));
    const path = join(directory, "resources.json");
    try {
      await writeFile(path, `{"records":"${"x".repeat(1_048_576)}"}`);
      await expect(
        runResourcesCli(configFromProcessEnv({ requireSecret: false, role: "resources" }), [
          "node",
          "main.js",
          "--role",
          "resources",
          "discover",
          "--input",
          path,
        ]),
      ).rejects.toThrow("no larger than 1048576 bytes");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("discovers without DATABASE_URL", async () => {
    const previous = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    const directory = await mkdtemp(join(tmpdir(), "jeb-resources-"));
    const path = join(directory, "resources.json");
    try {
      await writeFile(path, JSON.stringify([{ family: "url", value: "https://example.test/docs", source: "test", labels: ["documentation"] }]));
      const result = await runResourcesCli(configFromProcessEnv({ requireSecret: false, role: "resources" }), [
        "node",
        "main.js",
        "--role",
        "resources",
        "discover",
        "--input",
        path,
      ]);
      expect(result.ok).toBe(true);
      expect(JSON.parse(result.lines[0]!).accepted).toHaveLength(1);
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when config asks for production or publish", () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://user@127.0.0.1:5432/jeb";
    process.env.JEB_RESOURCE_TARGET = "production";
    process.env.JEB_RESOURCE_MODE = "shadow";
    expect(() => configFromProcessEnv({ requireSecret: false, role: "resources" })).toThrow("staging-only and shadow-only");
    process.env.JEB_RESOURCE_TARGET = "staging";
    process.env.JEB_RESOURCE_MODE = "publish";
    expect(() => configFromProcessEnv({ requireSecret: false, role: "resources" })).toThrow("staging-only and shadow-only");
  });

  it("refuses to discover when key material is present in the process", async () => {
    process.env.PUBKY_BOT_SECRET_KEY_HEX = "00".repeat(32);
    const directory = await mkdtemp(join(tmpdir(), "jeb-resources-"));
    const path = join(directory, "resources.json");
    try {
      await writeFile(path, JSON.stringify([{ family: "url", value: "https://example.test/docs", source: "test", labels: ["documentation"] }]));
      await expect(
        runResourcesCli(configFromProcessEnv({ requireSecret: false, role: "resources" }), [
          "node",
          "main.js",
          "--role",
          "resources",
          "discover",
          "--input",
          path,
        ]),
      ).rejects.toThrow("key material must not be present in this process");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
