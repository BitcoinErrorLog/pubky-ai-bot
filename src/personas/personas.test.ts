import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { FULL_TOOLS } from "../intent.js";
import { JEB_THREAD_IDENTITY } from "../context.js";
import { composeReply, systemPrompt } from "../compose.js";
import { assertWorkPersonaSnapshot, rejectInvalidPersonaWorkSnapshot, withPersonaSnapshotTrace } from "../reason.js";
import { metrics } from "../metrics.js";
import { log } from "../log.js";
import {
  CAPABILITY_CATALOGUE,
  CAPABILITY_RUNTIME_CONSUMERS,
  assertPersonaToolExecution,
  resolveCapabilities,
  selectPersonaToolNames,
} from "./capabilities.js";
import {
  AI_PORTRAYAL_IDENTITY_DISCLOSURE,
  AI_PORTRAYAL_PROFILE_DISCLOSURE,
  AI_ROLE_PROFILE_DISCLOSURE,
} from "./disclosure.js";
import { loadPersonaPack } from "./pack-loader.js";
import { loadPersonaRegistry, PersonaRegistry } from "./registry.js";
import {
  BINDING_RUNTIME_CONSUMERS,
  PACK_RUNTIME_CONSUMERS,
  createRuntimePersona,
  runtimeBindingContract,
  runtimePackContract,
} from "./runtime.js";
import {
  CAPABILITY_IDS,
  PersonaBindingSchema,
  PersonaPackSchema,
  type CapabilityId,
} from "./schema.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const manifestDir = path.join(repositoryRoot, "personas");
const JEB_BOT_PK = "9o6xrx8wgqu48dmb47uep6w3dgbwdnf5jgw83gbeuxg9yi7x444y";
const temporaryDirectories: string[] = [];

function manifestFieldPaths(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value) || value === null || typeof value !== "object") return [prefix];
  return Object.entries(value)
    .flatMap(([key, child]) => manifestFieldPaths(child, prefix ? `${prefix}.${key}` : key))
    .sort();
}

afterAll(() => {
  for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true });
});

describe("persona pack, binding, and registry", () => {
  it("loads Jeb as the sole enabled pack and binding", () => {
    const registry = loadPersonaRegistry({
      repositoryRoot,
      manifestDir,
      enabledPersonaIds: ["jeb"],
    });
    const jeb = registry.get("jeb");
    expect(registry.list()).toHaveLength(1);
    expect(jeb.pack.version).toBe("1.2.0");
    expect(jeb.binding.persona_id).toBe("jeb");
    expect(jeb.packHash).toMatch(/^[0-9a-f]{64}$/);
    expect(jeb.bindingHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(jeb)).toBe(true);
    expect(Object.isFrozen(jeb.pack)).toBe(true);
    expect(Object.isFrozen(jeb.binding)).toBe(true);
    expect(Object.isFrozen(jeb.profile)).toBe(true);
  });

  it("fails closed for unknown or disabled personas", () => {
    const registry = loadPersonaRegistry({
      repositoryRoot,
      manifestDir,
      enabledPersonaIds: ["jeb"],
    });
    expect(() => registry.get("unknown")).toThrow(/unknown or disabled persona/);
    expect(() =>
      loadPersonaRegistry({ repositoryRoot, manifestDir, enabledPersonaIds: ["unknown"] }),
    ).toThrow(/pack\/binding not found/);
  });

  it("rejects duplicate persona ids", () => {
    const jeb = loadPersonaRegistry({
      repositoryRoot,
      manifestDir,
      enabledPersonaIds: ["jeb"],
    }).get("jeb");
    expect(() => new PersonaRegistry([jeb, jeb])).toThrow(/duplicate persona id/);
  });

  it("loads a portable pack without any binding", () => {
    const portableRoot = fs.mkdtempSync(path.join(os.tmpdir(), "portable-pack-"));
    temporaryDirectories.push(portableRoot);
    fs.copyFileSync(path.join(manifestDir, "jeb", "pack.yaml"), path.join(portableRoot, "pack.yaml"));
    fs.copyFileSync(
      path.join(manifestDir, "jeb", "pack.snapshot.sha256"),
      path.join(portableRoot, "pack.snapshot.sha256"),
    );
    const loaded = loadPersonaPack(path.join(portableRoot, "pack.yaml"));
    expect(loaded.pack.id).toBe("jeb");
    expect(loaded.packHash).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.existsSync(path.join(portableRoot, "binding.yaml"))).toBe(false);
    const loaderImports = fs
      .readFileSync(path.join(repositoryRoot, "src/personas/pack-loader.ts"), "utf8")
      .split("\n")
      .filter((line) => line.startsWith("import "))
      .join("\n");
    expect(loaderImports).not.toMatch(/keys|db|tools|registry|profile|binding/i);
  });

  it("rejects unknown fields, path traversal, and pack/binding drift", () => {
    const registered = loadPersonaRegistry({
      repositoryRoot,
      manifestDir,
      enabledPersonaIds: ["jeb"],
    }).get("jeb");
    expect(PersonaPackSchema.safeParse({ ...registered.pack, extra: true }).success).toBe(false);
    expect(
      PersonaBindingSchema.safeParse({
        ...registered.binding,
        identity: { ...registered.binding.identity, profile_template: "../profile.json" },
      }).success,
    ).toBe(false);
    expect(
      PersonaPackSchema.safeParse({
        ...registered.pack,
        voice: { ...registered.pack.voice, intro_line: "missing placeholder" },
      }).success,
    ).toBe(false);
    expect(
      PersonaPackSchema.safeParse({
        ...registered.pack,
        capabilities: { ...registered.pack.capabilities, allow: ["not_a_capability"] },
      }).success,
    ).toBe(false);
    expect(
      PersonaPackSchema.safeParse({
        ...registered.pack,
        corpus_namespace: "persona/satoshi-nakamoto/1.2.0",
      }).success,
    ).toBe(false);
    expect(
      PersonaBindingSchema.safeParse({
        ...registered.binding,
        pack_version: "2.0.0",
      }).success,
    ).toBe(true);
  });

  it("rejects pack drift and symlinked packs", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jeb-persona-snapshot-"));
    temporaryDirectories.push(root);
    const copiedManifestDir = path.join(root, "personas");
    fs.mkdirSync(copiedManifestDir, { recursive: true });
    fs.cpSync(path.join(manifestDir, "jeb"), path.join(copiedManifestDir, "jeb"), { recursive: true });
    fs.appendFileSync(path.join(copiedManifestDir, "jeb", "pack.yaml"), "\n# mutated\n");
    expect(() =>
      loadPersonaRegistry({
        repositoryRoot: root,
        manifestDir: copiedManifestDir,
        enabledPersonaIds: ["jeb"],
      }),
    ).toThrow(/pack .* hash mismatch/);

    const outside = path.join(root, "outside.yaml");
    fs.writeFileSync(outside, "schema_version: 1\n");
    fs.mkdirSync(path.join(copiedManifestDir, "evil"));
    fs.symlinkSync(outside, path.join(copiedManifestDir, "evil", "pack.yaml"));
    fs.writeFileSync(
      path.join(copiedManifestDir, "evil", "binding.yaml"),
      "schema_version: 1\npersona_id: evil\npack_version: 1.0.0\nidentity: {}\n",
    );
    expect(() =>
      loadPersonaRegistry({
        repositoryRoot: root,
        manifestDir: copiedManifestDir,
        enabledPersonaIds: ["evil"],
      }),
    ).toThrow(/pack\/binding not found|symlink/);
  });
});

describe("persona capability catalogue", () => {
  it("defines every stable capability id exactly once", () => {
    expect(new Set(CAPABILITY_IDS).size).toBe(CAPABILITY_IDS.length);
  });

  it("expands only explicitly allowed Jeb tools", () => {
    const pack = loadPersonaRegistry({
      repositoryRoot,
      manifestDir,
      enabledPersonaIds: ["jeb"],
    }).get("jeb").pack;
    const resolved = resolveCapabilities(pack);
    expect(resolved.enabled.has("scout_graph")).toBe(true);
    expect(resolved.tools.has("get_emerging_topics")).toBe(true);
    expect(resolved.tools.has("search_knowledge")).toBe(true);
    expect(resolved.tools.has("query_graph")).toBe(false);
  });

  it("intersects manifest grants with deployment availability", () => {
    const resolved = resolveCapabilities(
      { capabilities: { allow: ["nexus_read", "web_search"] } },
      new Set<CapabilityId>(["nexus_read"]),
    );
    expect(resolved.enabled).toEqual(new Set(["nexus_read"]));
    expect(resolved.tools.has("get_post")).toBe(true);
    expect(resolved.tools.has("search_web")).toBe(false);
  });

  it("keeps Jeb's system prompt byte-identical while removing denied tool schemas", () => {
    const snapshot = loadPersonaRegistry({
      repositoryRoot,
      manifestDir,
      enabledPersonaIds: ["jeb"],
    }).get("jeb");
    const runtime = createRuntimePersona(snapshot, { appUrl: "https://pubky.app" });
    expect(manifestFieldPaths(runtimePackContract(snapshot.pack))).toEqual(
      manifestFieldPaths(snapshot.pack),
    );
    expect(Object.keys(PACK_RUNTIME_CONSUMERS).sort()).toEqual(
      manifestFieldPaths(snapshot.pack),
    );
    expect(Object.keys(BINDING_RUNTIME_CONSUMERS).sort()).toEqual(
      manifestFieldPaths(snapshot.binding),
    );
    expect(manifestFieldPaths(runtimeBindingContract(snapshot.binding))).toEqual(
      manifestFieldPaths(snapshot.binding),
    );
    expect(Object.values(PACK_RUNTIME_CONSUMERS).every(Boolean)).toBe(true);
    expect(Object.values(BINDING_RUNTIME_CONSUMERS).every(Boolean)).toBe(true);
    expect(runtime.systemPrompt).toBe(systemPrompt("https://pubky.app"));
    expect(runtime.threadIdentity.assistantRoleLabel).toBe(JEB_THREAD_IDENTITY.assistantRoleLabel);
    expect(runtime.threadIdentity.introLine(JEB_BOT_PK)).toBe(
      JEB_THREAD_IDENTITY.introLine(JEB_BOT_PK),
    );
    const available = [...FULL_TOOLS, "search_knowledge"];
    const selected = selectPersonaToolNames(new Set(FULL_TOOLS), available, runtime.capabilities);
    expect(selected).toEqual([
      ...FULL_TOOLS.filter((tool) => tool !== "query_graph"),
      "search_knowledge",
    ]);
    expect(() => assertPersonaToolExecution("query_graph", runtime.capabilities)).toThrow(/denied/);
    expect(() =>
      assertWorkPersonaSnapshot(
        {
          persona: {
            id: snapshot.pack.id,
            version: snapshot.pack.version,
            hash: snapshot.snapshotHash,
          },
        },
        runtime,
      ),
    ).not.toThrow();
    expect(() =>
      assertWorkPersonaSnapshot(
        {
          persona: {
            id: snapshot.pack.id,
            version: snapshot.pack.version,
            hash: "0".repeat(64),
          },
        },
        runtime,
      ),
    ).toThrow(/unknown or no longer available/);
    expect(() => assertWorkPersonaSnapshot({ mentionKey: "legacy" }, runtime)).toThrow(
      /missing a persona snapshot/,
    );
    const stamped = { id: snapshot.pack.id, version: snapshot.pack.version, hash: snapshot.snapshotHash };
    expect(withPersonaSnapshotTrace([{ quota_notice: "thread_cap" }], stamped)).toEqual([
      { persona_snapshot: stamped },
      { quota_notice: "thread_cap" },
    ]);
    const modelTrace = [{ persona_snapshot: { ...stamped, namespace: "persona/jeb/1.1.0" } }, { tool: "get_post" }];
    expect(withPersonaSnapshotTrace(modelTrace, stamped)).toBe(modelTrace);
    expect(withPersonaSnapshotTrace([], undefined)).toEqual([]);
    expect(
      composeReply("A detailed answer.", new Set(["deep"]), [], {
        longFormFooter: runtime.longFormFooter,
      }).content,
    ).toContain(runtime.longFormFooter);
  });

  it("requires every capability id to have a concrete runtime consumer or gate", () => {
    expect(Object.keys(CAPABILITY_CATALOGUE).sort()).toEqual([...CAPABILITY_IDS].sort());
    expect(Object.keys(CAPABILITY_RUNTIME_CONSUMERS).sort()).toEqual([...CAPABILITY_IDS].sort());
    for (const id of CAPABILITY_IDS) {
      expect(CAPABILITY_RUNTIME_CONSUMERS[id].length, `${id} runtime consumers`).toBeGreaterThan(0);
      const definition = CAPABILITY_CATALOGUE[id];
      if (definition.surface === "model_tool") {
        expect(definition.tools.length, `${id} tool expansion`).toBeGreaterThan(0);
      }
    }
  });

  it("fails closed, logs, and meters work with no snapshot", async () => {
    const snapshot = loadPersonaRegistry({
      repositoryRoot,
      manifestDir,
      enabledPersonaIds: ["jeb"],
    }).get("jeb");
    const runtime = createRuntimePersona(snapshot, { appUrl: "https://pubky.app" });
    const marked: Array<{ key: string; status: string }> = [];
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined as never);
    const before = await metrics.getMetrics();
    expect(
      await rejectInvalidPersonaWorkSnapshot(
        {
          mark: async (key, status) => {
            marked.push({ key, status });
          },
        },
        { mention_key: "missing-snapshot", payload: { mentionKey: "missing-snapshot" } },
        runtime,
      ),
    ).toBe(true);
    const after = await metrics.getMetrics();
    expect(marked).toEqual([{ key: "missing-snapshot", status: "failed" }]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "persona_snapshot_rejected", outcome: "invalid" }),
      expect.any(String),
    );
    expect(after).not.toBe(before);
    expect(after).toContain('jeb_actions_total{action="answer",status="persona_snapshot_invalid"}');
    warn.mockRestore();
  });
});

describe("persona disclosure contract", () => {
  it("fits current profile limits and states operator, automation, and non-authority", () => {
    for (const copy of [AI_ROLE_PROFILE_DISCLOSURE, AI_PORTRAYAL_PROFILE_DISCLOSURE]) {
      expect(copy.length).toBeLessThanOrEqual(160);
      expect(copy).toContain("Synonym");
      expect(copy).toMatch(/\bAI (role|portrayal)\b/);
      expect(copy).toContain("not");
      expect(copy).toContain("authority");
    }
    expect(AI_PORTRAYAL_IDENTITY_DISCLOSURE).toMatch(/^I am an AI portrayal operated by Synonym/);
    expect(AI_PORTRAYAL_IDENTITY_DISCLOSURE).toContain("not the real person");
  });
});
