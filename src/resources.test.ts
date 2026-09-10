import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configFromProcessEnv } from "./config.js";
import type { ResourceRun } from "./external-resources.js";
import { STAGING_HOMESERVER_PK } from "./outbound-gate.js";
import { assertDiscoveryHaltAllowsPublish, assertResourceBuildStamp, runResourcesCli } from "./resources.js";
import { RESOURCE_CONFIG_VERSION } from "./resource-taxonomy.js";
import { sourceTreeHash } from "./source-tree-hash.js";

beforeEach(() => {
  delete process.env.PUBKY_BOT_SECRET_KEY_HEX;
  delete process.env.PUBKY_BOT_SECRET_KEY_FILE;
  delete process.env.PUBKY_BOT_MNEMONIC;
  delete process.env.JEB_RESOURCE_TARGET;
  delete process.env.JEB_RESOURCE_MODE;
  delete process.env.JEB_HOMESERVER;
});

afterEach(() => {
  delete process.env.JEB_RESOURCE_TARGET;
  delete process.env.JEB_RESOURCE_MODE;
  delete process.env.JEB_HOMESERVER;
  delete process.env.PUBKY_BOT_SECRET_KEY_HEX;
  delete process.env.PUBKY_BOT_SECRET_KEY_FILE;
  delete process.env.PUBKY_BOT_MNEMONIC;
});

describe("resources CLI boundary", () => {
  async function validStamp(gitHead = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()) {
    return { configVersion: RESOURCE_CONFIG_VERSION, gitHead, sourceHash: await sourceTreeHash() };
  }

  it("refuses publish mode for a missing or stale build stamp", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jeb-stamp-"));
    const path = join(directory, "build-stamp.json");
    try {
      await expect(assertResourceBuildStamp("publish", { stampPath: path, gitHead: "head" })).rejects.toThrow("missing build stamp");
      await writeFile(path, JSON.stringify({ ...(await validStamp()), configVersion: "old" }));
      await expect(assertResourceBuildStamp("publish", { stampPath: path, gitHead: "head" })).rejects.toThrow("config version");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("accepts a matching build stamp and warns for missing shadow stamps", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jeb-stamp-"));
    const path = join(directory, "build-stamp.json");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await writeFile(path, JSON.stringify(await validStamp("head")));
      await expect(assertResourceBuildStamp("publish", { stampPath: path, gitHead: "head" })).resolves.toBeUndefined();
      await assertResourceBuildStamp("shadow", { stampPath: join(directory, "missing.json"), gitHead: "head" });
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("shadow continues"));
    } finally {
      warning.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([null, [], "x", { configVersion: RESOURCE_CONFIG_VERSION, gitHead: "head" }])(
    "refuses malformed build stamp %j",
    async (stamp) => {
      const directory = await mkdtemp(join(tmpdir(), "jeb-stamp-"));
      const path = join(directory, "build-stamp.json");
      try {
        await writeFile(path, JSON.stringify(stamp));
        await expect(assertResourceBuildStamp("publish", { stampPath: path, gitHead: "head" })).rejects.toThrow(
          "resource publish refused: malformed build stamp",
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("refuses a source hash mismatch with an actionable message", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jeb-stamp-"));
    const path = join(directory, "build-stamp.json");
    try {
      await writeFile(path, JSON.stringify({ ...(await validStamp("head")), sourceHash: "stale-source" }));
      await expect(assertResourceBuildStamp("publish", { stampPath: path, gitHead: "head" })).rejects.toThrow(
        /stale build stamp: source hash stale-source does not match/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses after a source file changes in a temporary source tree", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jeb-stamp-"));
    const sourceDirectory = join(directory, "src");
    const stampPath = join(directory, "build-stamp.json");
    try {
      await mkdir(sourceDirectory);
      await writeFile(join(sourceDirectory, "resource.ts"), "export const value = 1;\n");
      const sourceHash = await sourceTreeHash(directory);
      await writeFile(stampPath, JSON.stringify({ configVersion: RESOURCE_CONFIG_VERSION, gitHead: "head", sourceHash }));
      await writeFile(join(sourceDirectory, "resource.ts"), "export const value = 2;\n");
      await expect(
        assertResourceBuildStamp("publish", { stampPath, gitHead: "head", sourceRoot: directory }),
      ).rejects.toThrow("source hash");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reads a real JSON input file and preserves the shadow-only boundary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jeb-resources-"));
    const path = join(directory, "resources.json");
    try {
      await writeFile(path, JSON.stringify([{ family: "url", value: "https://example.test/docs", source: "staging-catalog", labels: ["release"] }]));
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
      await writeFile(path, JSON.stringify([{ family: "url", value: "https://example.test/docs", source: "staging-catalog", labels: ["release"] }]));
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

  it("fails closed when config asks for production", () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://user@127.0.0.1:5432/jeb";
    process.env.JEB_RESOURCE_TARGET = "production";
    process.env.JEB_RESOURCE_MODE = "shadow";
    expect(() => configFromProcessEnv({ requireSecret: false, role: "resources" })).toThrow("staging-only");
    process.env.JEB_RESOURCE_MODE = "publish";
    expect(() => configFromProcessEnv({ requireSecret: false, role: "resources" })).toThrow("staging-only");
  });

  it("loads staging publish mode at config time", () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://user@127.0.0.1:5432/jeb";
    process.env.JEB_RESOURCE_TARGET = "staging";
    process.env.JEB_RESOURCE_MODE = "publish";
    process.env.JEB_HOMESERVER = STAGING_HOMESERVER_PK;
    const cfg = configFromProcessEnv({ requireSecret: false, role: "resources" });
    expect(cfg.resourceMode).toBe("publish");
    expect(cfg.resourceApp).toBe("jeb.pubky.app");
    expect(cfg.homeserverPk).toBe(STAGING_HOMESERVER_PK);
  });

  it("throws at config when publish mode uses a non-staging JEB_HOMESERVER", () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://user@127.0.0.1:5432/jeb";
    process.env.JEB_RESOURCE_TARGET = "staging";
    process.env.JEB_RESOURCE_MODE = "publish";
    process.env.JEB_HOMESERVER = "8um71us3aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    expect(() => configFromProcessEnv({ requireSecret: false, role: "resources" })).toThrow(
      /homeserver public key is not the staging homeserver/,
    );
  });

  it("throws at CLI when --mode publish has a non-staging homeserver pk", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jeb-resources-"));
    const path = join(directory, "resources.json");
    try {
      await writeFile(path, JSON.stringify([{ family: "url", value: "https://example.test/docs", source: "staging-catalog", labels: ["release"] }]));
      process.env.JEB_RESOURCE_MODE = "shadow";
      const cfg = configFromProcessEnv({ requireSecret: false, role: "resources" });
      cfg.homeserverPk = "8um71us3aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const buildStampPath = join(directory, "build-stamp.json");
      await writeFile(buildStampPath, JSON.stringify(await validStamp()));
      await expect(
        runResourcesCli(
          cfg,
          ["node", "main.js", "--role", "resources", "discover", "--input", path, "--mode", "publish", "--target", "staging"],
          { buildStampPath },
        ),
      ).rejects.toThrow(/homeserver public key is not the staging homeserver/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses to discover when key material is present in the process", async () => {
    process.env.PUBKY_BOT_SECRET_KEY_HEX = "00".repeat(32);
    const directory = await mkdtemp(join(tmpdir(), "jeb-resources-"));
    const path = join(directory, "resources.json");
    try {
      await writeFile(path, JSON.stringify([{ family: "url", value: "https://example.test/docs", source: "staging-catalog", labels: ["release"] }]));
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

  it("shadow mode never calls the homeserver client", async () => {
    const puts: string[] = [];
    const transport = {
      botPk: "8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo",
      putJson: async (path: string) => {
        puts.push(path);
      },
      putBytes: async () => {},
      getJson: async () => {
        throw new Error("404");
      },
      deleteJson: async () => {},
      listPosts: async () => [],
      reauth: async () => {},
    };
    const directory = await mkdtemp(join(tmpdir(), "jeb-resources-"));
    const path = join(directory, "resources.json");
    try {
      await writeFile(path, JSON.stringify([{ family: "url", value: "https://example.test/docs", source: "staging-catalog", labels: ["release"] }]));
      const result = await runResourcesCli(
        configFromProcessEnv({ requireSecret: false, role: "resources" }),
        ["node", "main.js", "--role", "resources", "discover", "--input", path, "--mode", "shadow"],
        { transport },
      );
      expect(result.ok).toBe(true);
      expect(JSON.parse(result.lines[0]!).mode).toBe("shadow");
      expect(puts).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("publish mode writes through the injected homeserver client", async () => {
    const puts: string[] = [];
    const store = new Map<string, unknown>();
    const transport = {
      botPk: "8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo",
      resolvedHomeserverPk: STAGING_HOMESERVER_PK,
      putJson: async (path: string, json: unknown) => {
        puts.push(path);
        store.set(path, json);
      },
      putBytes: async () => {},
      getJson: async (path: string) => {
        if (!store.has(path)) throw new Error("404 Not Found");
        return store.get(path);
      },
      deleteJson: async () => {},
      listPosts: async () => [],
      reauth: async () => {},
    };
    const directory = await mkdtemp(join(tmpdir(), "jeb-resources-"));
    const path = join(directory, "resources.json");
    try {
      await writeFile(path, JSON.stringify([{ family: "url", value: "https://example.test/docs", source: "staging-catalog", labels: ["release"] }]));
      const buildStampPath = join(directory, "build-stamp.json");
      await writeFile(buildStampPath, JSON.stringify(await validStamp("test-head")));
      process.env.JEB_RESOURCE_TARGET = "staging";
      process.env.JEB_RESOURCE_MODE = "shadow";
      process.env.JEB_HOMESERVER = STAGING_HOMESERVER_PK;
      const result = await runResourcesCli(
        configFromProcessEnv({ requireSecret: false, role: "resources" }),
        ["node", "main.js", "--role", "resources", "discover", "--input", path, "--mode", "publish", "--target", "staging"],
        { transport, buildStampPath, gitHead: "test-head" },
      );
      expect(result.ok).toBe(true);
      const payload = JSON.parse(result.lines[0]!);
      expect(payload.mode).toBe("publish");
      expect(payload.publish.written).toBeGreaterThan(0);
      expect(puts.length).toBe(payload.publish.written);
      expect(puts.every((p: string) => p.startsWith("/pub/jeb.pubky.app/tags/"))).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("discovery halt guard", () => {
  const runWithHalt = (halt: { reason: string } | null): ResourceRun =>
    ({ shadowReport: { halt } }) as unknown as ResourceRun;

  it("refuses publish and reconcile when a discovery sub-source is unavailable", () => {
    expect(() => assertDiscoveryHaltAllowsPublish(runWithHalt({ reason: "source-unavailable" }))).toThrow(
      "resource publish/reconcile refused: source-unavailable",
    );
  });

  it("allows publish when no discovery halt is set or the halt is not source-unavailable", () => {
    expect(() => assertDiscoveryHaltAllowsPublish(runWithHalt(null))).not.toThrow();
    expect(() => assertDiscoveryHaltAllowsPublish(runWithHalt({ reason: "model-failure-rate" }))).not.toThrow();
  });
});
