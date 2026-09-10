import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configFromProcessEnv } from "./config.js";
import { STAGING_HOMESERVER_PK } from "./outbound-gate.js";
import { assertResourceBuildStamp, runResourcesCli } from "./resources.js";
import { RESOURCE_CONFIG_VERSION } from "./resource-taxonomy.js";
import { distArtifactHash } from "./dist-artifact-hash.js";
import { RESOURCE_PIN_SET_VERSION, STAGING_RESOURCE_PROFILE } from "./resource-target-profile.js";

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

/** A deployed-artifact tree shaped like the runtime image: `dist`, no source. */
async function seedDistTree(root: string): Promise<string> {
  const distRoot = join(root, "dist");
  await mkdir(distRoot, { recursive: true });
  await writeFile(join(distRoot, "main.js"), "console.log('jeb');\n");
  await writeFile(join(distRoot, "resource-taxonomy.js"), `export const RESOURCE_CONFIG_VERSION = "${RESOURCE_CONFIG_VERSION}";\n`);
  return distRoot;
}

async function validStamp(
  distRoot: string,
  gitHead = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
): Promise<{ configVersion: string; pinSetVersion: string; gitHead: string; distHash: string }> {
  return {
    configVersion: RESOURCE_CONFIG_VERSION,
    pinSetVersion: RESOURCE_PIN_SET_VERSION,
    gitHead,
    distHash: await distArtifactHash(distRoot),
  };
}

describe("resources CLI boundary", () => {
  it("refuses publish mode for a missing or stale build stamp", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jeb-stamp-"));
    const distRoot = await seedDistTree(directory);
    const path = join(distRoot, "build-stamp.json");
    try {
      await expect(assertResourceBuildStamp("publish", { stampPath: path, gitHead: "head" })).rejects.toThrow("missing build stamp");
      await writeFile(path, JSON.stringify({ ...(await validStamp(distRoot)), configVersion: "old" }));
      await expect(assertResourceBuildStamp("publish", { stampPath: path, gitHead: "head" })).rejects.toThrow("config_version");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("accepts a matching build stamp and warns for missing shadow stamps", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jeb-stamp-"));
    const distRoot = await seedDistTree(directory);
    const path = join(distRoot, "build-stamp.json");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await writeFile(path, JSON.stringify(await validStamp(distRoot, "head")));
      await expect(assertResourceBuildStamp("publish", { stampPath: path, gitHead: "head" })).resolves.toBeUndefined();
      await assertResourceBuildStamp("shadow", { stampPath: join(distRoot, "missing.json"), gitHead: "head" });
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("shadow continues"));
    } finally {
      warning.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    null,
    [],
    "x",
    { configVersion: RESOURCE_CONFIG_VERSION, gitHead: "head" },
    // A stamp from the retired source-tree writer carries no deployed-artifact
    // hash, so it is malformed rather than silently accepted.
    { configVersion: RESOURCE_CONFIG_VERSION, gitHead: "head", sourceHash: "a".repeat(64) },
    // A stamp that predates the pin set cannot prove which pins are compiled.
    { configVersion: RESOURCE_CONFIG_VERSION, gitHead: "head", distHash: "a".repeat(64) },
  ])(
    "refuses malformed build stamp %j",
    async (stamp) => {
      const directory = await mkdtemp(join(tmpdir(), "jeb-stamp-"));
      const distRoot = await seedDistTree(directory);
      const path = join(distRoot, "build-stamp.json");
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

  it("refuses a deployed-artifact hash mismatch with a bounded class", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jeb-stamp-"));
    const distRoot = await seedDistTree(directory);
    const path = join(distRoot, "build-stamp.json");
    try {
      await writeFile(path, JSON.stringify({ ...(await validStamp(distRoot, "head")), distHash: "b".repeat(64) }));
      await expect(assertResourceBuildStamp("publish", { stampPath: path, gitHead: "head" })).rejects.toThrow(
        /stale build stamp: dist_hash/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses after one deployed byte changes under dist", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jeb-stamp-"));
    const distRoot = await seedDistTree(directory);
    const stampPath = join(distRoot, "build-stamp.json");
    try {
      await writeFile(stampPath, JSON.stringify(await validStamp(distRoot, "head")));
      await expect(assertResourceBuildStamp("publish", { stampPath, gitHead: "head" })).resolves.toBeUndefined();
      await writeFile(join(distRoot, "main.js"), "console.log('jeb');\n\n");
      await expect(assertResourceBuildStamp("publish", { stampPath, gitHead: "head" })).rejects.toThrow("dist_hash");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses a pin-set version mismatch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jeb-stamp-"));
    const distRoot = await seedDistTree(directory);
    const stampPath = join(distRoot, "build-stamp.json");
    try {
      await writeFile(stampPath, JSON.stringify({ ...(await validStamp(distRoot, "head")), pinSetVersion: "resource-pins-v0" }));
      await expect(assertResourceBuildStamp("publish", { stampPath, gitHead: "head" })).rejects.toThrow("pin_set_version");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses a git head mismatch before checking artifacts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jeb-stamp-"));
    const distRoot = await seedDistTree(directory);
    const stampPath = join(distRoot, "build-stamp.json");
    try {
      await writeFile(stampPath, JSON.stringify(await validStamp(distRoot, "other-head")));
      await expect(assertResourceBuildStamp("publish", { stampPath, gitHead: "head" })).rejects.toThrow("git_head");
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
      const distRoot = await seedDistTree(directory);
      const buildStampPath = join(distRoot, "build-stamp.json");
      await writeFile(buildStampPath, JSON.stringify(await validStamp(distRoot)));
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

  it("builds the resource Nexus client from the compiled profile, not JEB_NEXUS_URL", async () => {
    const requested: string[] = [];
    const realFetch = globalThis.fetch;
    process.env.JEB_NEXUS_URL = "https://nexus.attacker.test";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requested.push(String(input instanceof URL ? input : input instanceof Request ? input.url : input));
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const cfg = configFromProcessEnv({ requireSecret: false, role: "resources" });
      expect(cfg.nexusUrl).toBe("https://nexus.attacker.test");
      const result = await runResourcesCli(cfg, [
        "node", "main.js", "--role", "resources", "--source", "pubky-posts", "--mode", "shadow", "--limit", "1",
      ]);
      expect(result.ok).toBe(true);
      expect(requested.length).toBeGreaterThan(0);
      const expectedOrigin = new URL(STAGING_RESOURCE_PROFILE.nexusUrl).origin;
      for (const url of requested) {
        expect(new URL(url).origin).toBe(expectedOrigin);
      }
      // Deliberate negative: the hostile env host must appear nowhere.
      expect(requested.some((url) => url.includes("nexus.attacker.test"))).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.JEB_NEXUS_URL;
    }
  });

  it("refuses two family selectors before touching the build stamp", async () => {
    const cfg = configFromProcessEnv({ requireSecret: false, role: "resources" });
    const result = await runResourcesCli(cfg, [
      "node", "main.js", "--role", "resources", "discover", "--input", "/tmp/absent.json", "--source", "pubky-posts",
    ], { buildStampPath: "/tmp/jeb-nonexistent-stamp.json" });
    expect(result.ok).toBe(false);
    expect(result.lines[0]).toMatch(/mutually exclusive/);
    // The refusal happened before stamp verification, so no stamp complaint.
    expect(result.lines.join("\n")).not.toMatch(/build stamp/);
  });

  it("refuses an unknown command with usage and zero discovery", async () => {
    const cfg = configFromProcessEnv({ requireSecret: false, role: "resources" });
    const result = await runResourcesCli(cfg, ["node", "main.js", "--role", "resources", "seed"]);
    expect(result.ok).toBe(false);
    expect(result.lines[0]).toMatch(/unknown command 'seed'/);
    expect(result.lines.some((line) => line.startsWith("usage:"))).toBe(true);
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
      const distRoot = await seedDistTree(directory);
      const buildStampPath = join(distRoot, "build-stamp.json");
      await writeFile(buildStampPath, JSON.stringify(await validStamp(distRoot, "test-head")));
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
