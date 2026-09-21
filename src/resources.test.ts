import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configFromProcessEnv, type Config } from "./config.js";
import { RESOURCE_PILOT_BOT_PK, STAGING_HOMESERVER_PK } from "./outbound-gate.js";
import { DEFAULT_RESOURCE_APP, buildUniversalResourceTag } from "./resource-publish.js";
import { normalizeUri } from "./resource-identity.js";
import { assertResourceBuildStamp, runResourcesCli } from "./resources.js";
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

async function validStamp(gitHead = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()) {
  return { configVersion: RESOURCE_CONFIG_VERSION, gitHead, sourceHash: await sourceTreeHash() };
}

describe("resources CLI boundary", () => {
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
      // The single-process publish path was removed: publish requires a plan artifact.
      await expect(
        runResourcesCli(
          configFromProcessEnv({ requireSecret: false, role: "resources" }),
          ["node", "main.js", "--role", "resources", "discover", "--input", path, "--mode", "publish", "--target", "staging"],
          { transport, buildStampPath, gitHead: "test-head" },
        ),
      ).rejects.toThrow("publish requires --plan <file> written by --mode plan; the single-process publish path was removed");
      expect(puts).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("resources plan-hash gate", () => {
  function stagingEnv(): void {
    process.env.JEB_RESOURCE_TARGET = "staging";
    process.env.JEB_RESOURCE_MODE = "shadow";
    process.env.JEB_HOMESERVER = STAGING_HOMESERVER_PK;
  }

  function fakeTransport() {
    const store = new Map<string, unknown>();
    const puts: string[] = [];
    return {
      botPk: RESOURCE_PILOT_BOT_PK,
      resolvedHomeserverPk: STAGING_HOMESERVER_PK,
      puts,
      store,
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
  }

  type PlanSetup = {
    cfg: Config;
    directory: string;
    inputPath: string;
    buildStampPath: string;
    planPath: string;
    sha: string;
    summary: Record<string, unknown>;
    runPayload: Record<string, unknown>;
  };

  async function planViaCli(existingTagReader?: (path: string) => Promise<never>): Promise<PlanSetup> {
    stagingEnv();
    const cfg = configFromProcessEnv({ requireSecret: false, role: "resources" });
    const directory = await mkdtemp(join(tmpdir(), "jeb-plan-gate-"));
    const inputPath = join(directory, "resources.json");
    await writeFile(inputPath, JSON.stringify([{ family: "url", value: "https://example.test/docs", source: "staging-catalog", labels: ["release"] }]));
    const buildStampPath = join(directory, "build-stamp.json");
    await writeFile(buildStampPath, JSON.stringify(await validStamp("test-head")));
    const planPath = join(directory, "plan.json");
    const result = await runResourcesCli(
      cfg,
      ["node", "main.js", "--role", "resources", "discover", "--input", inputPath, "--mode", "plan", "--plan-out", planPath],
      { buildStampPath, gitHead: "test-head", existingTagReader: existingTagReader ?? (async () => null) },
    );
    expect(result.ok).toBe(true);
    const summary = JSON.parse(result.lines[0]!);
    const runPayload = JSON.parse(result.lines[1]!);
    return { cfg, directory, inputPath, buildStampPath, planPath, sha: summary.plan_sha256, summary, runPayload };
  }

  it("--mode plan writes a file whose plan_sha256 equals the sha256 of its bytes, covering every accepted label", async () => {
    const setup = await planViaCli();
    try {
      const bytes = await readFile(setup.planPath);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(setup.sha);
      const artifact = JSON.parse(bytes.toString("utf8"));
      const labels = setup.runPayload.accepted[0].labels as string[];
      expect(setup.runPayload.mode).toBe("plan");
      expect(artifact.actions).toHaveLength(labels.length);
      expect(artifact.actions.map((a: { body: { label: string } }) => a.body.label).sort()).toEqual([...labels].sort());
      expect(setup.summary.puts).toBe(labels.length);
      expect(setup.summary.family).toBe("discover");
      expect(setup.summary.target).toBe("staging");
    } finally {
      await rm(setup.directory, { recursive: true, force: true });
    }
  });

  it("--mode plan emits keep and zero puts when the public reader returns an identical tag", async () => {
    const built = buildUniversalResourceTag(RESOURCE_PILOT_BOT_PK, DEFAULT_RESOURCE_APP, normalizeUri("https://example.test/docs"), "release");
    const setup = await planViaCli(async (path: string) => (path === built.path ? built.body : null) as never);
    try {
      expect(setup.summary.puts).toBe(0);
      expect(setup.summary.keeps).toBe(1);
      expect(setup.summary.resources).toBe(1);
      const artifact = JSON.parse((await readFile(setup.planPath)).toString("utf8"));
      expect(artifact.actions).toEqual([]);
      expect(artifact.resources[0].keep).toEqual(["release"]);
    } finally {
      await rm(setup.directory, { recursive: true, force: true });
    }
  });

  it("--mode publish --execute without --confirm-plan is refused", async () => {
    const setup = await planViaCli();
    try {
      await expect(
        runResourcesCli(
          setup.cfg,
          ["node", "main.js", "--role", "resources", "discover", "--input", setup.inputPath, "--mode", "publish", "--plan", setup.planPath, "--execute"],
          { buildStampPath: setup.buildStampPath, gitHead: "test-head", transport: fakeTransport() },
        ),
      ).rejects.toThrow("--execute requires --confirm-plan");
    } finally {
      await rm(setup.directory, { recursive: true, force: true });
    }
  });

  it("--mode publish --execute with the wrong --confirm-plan sha is refused", async () => {
    const setup = await planViaCli();
    try {
      await expect(
        runResourcesCli(
          setup.cfg,
          ["node", "main.js", "--role", "resources", "discover", "--input", setup.inputPath, "--mode", "publish", "--plan", setup.planPath, "--execute", "--confirm-plan", "00".repeat(32)],
          { buildStampPath: setup.buildStampPath, gitHead: "test-head", transport: fakeTransport() },
        ),
      ).rejects.toThrow("--confirm-plan does not match the plan artifact");
    } finally {
      await rm(setup.directory, { recursive: true, force: true });
    }
  });

  it("--mode publish refuses a plan file with one edited byte", async () => {
    const setup = await planViaCli();
    try {
      const original = (await readFile(setup.planPath)).toString("utf8");
      expect(original).toContain('"fetch":false');
      await writeFile(setup.planPath, original.replace('"fetch":false', '"fetch": false'));
      await expect(
        runResourcesCli(
          setup.cfg,
          ["node", "main.js", "--role", "resources", "discover", "--input", setup.inputPath, "--mode", "publish", "--plan", setup.planPath],
          { buildStampPath: setup.buildStampPath, gitHead: "test-head" },
        ),
      ).rejects.toThrow("not in canonical form");
    } finally {
      await rm(setup.directory, { recursive: true, force: true });
    }
  });

  it("dry publish never calls openTransport", async () => {
    const setup = await planViaCli();
    try {
      const result = await runResourcesCli(
        setup.cfg,
        ["node", "main.js", "--role", "resources", "discover", "--input", setup.inputPath, "--mode", "publish", "--plan", setup.planPath],
        {
          buildStampPath: setup.buildStampPath,
          gitHead: "test-head",
          openTransport: async () => {
            throw new Error("dry publish must not open a session");
          },
        },
      );
      expect(result.ok).toBe(true);
      const payload = JSON.parse(result.lines[0]!);
      expect(payload.mode).toBe("publish");
      expect(payload.executed).toBe(false);
      expect(payload.plan_sha256).toBe(setup.sha);
      expect(payload.puts).toBe(setup.summary.puts);
    } finally {
      await rm(setup.directory, { recursive: true, force: true });
    }
  });

  it("--execute writes exactly the artifact's actions; a second run reports skipped=puts, written=0", async () => {
    const setup = await planViaCli();
    try {
      const transport = fakeTransport();
      const argv = ["node", "main.js", "--role", "resources", "discover", "--input", setup.inputPath, "--mode", "publish", "--plan", setup.planPath, "--execute", "--confirm-plan", setup.sha];
      const deps = { buildStampPath: setup.buildStampPath, gitHead: "test-head", transport };
      const first = await runResourcesCli(setup.cfg, argv, deps);
      expect(first.ok).toBe(true);
      const p1 = JSON.parse(first.lines[0]!);
      expect(p1.executed).toBe(true);
      expect(p1.written).toBe(p1.puts);
      expect(p1.failed).toBe(0);
      expect(p1.verified).toBe(true);
      const artifact = JSON.parse((await readFile(setup.planPath)).toString("utf8"));
      expect([...transport.puts].sort()).toEqual(artifact.actions.map((a: { path: string }) => a.path).sort());
      const second = await runResourcesCli(setup.cfg, argv, deps);
      expect(second.ok).toBe(true);
      const p2 = JSON.parse(second.lines[0]!);
      expect(p2.skipped).toBe(p1.puts);
      expect(p2.written).toBe(0);
      expect(p2.failed).toBe(0);
    } finally {
      await rm(setup.directory, { recursive: true, force: true });
    }
  });
});
