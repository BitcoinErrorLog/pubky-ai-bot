import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { FULL_TOOLS } from "../intent.js";
import { JEB_THREAD_IDENTITY } from "../context.js";
import { composeReply, systemPrompt } from "../compose.js";
import { assertWorkPersonaSnapshot, rejectInvalidPersonaWorkSnapshot } from "../reason.js";
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
import { loadPersonaRegistry, PersonaRegistry } from "./registry.js";
import {
  MANIFEST_RUNTIME_CONSUMERS,
  createRuntimePersona,
  runtimeManifestContract,
} from "./runtime.js";
import { CAPABILITY_IDS, PersonaManifestSchema, type CapabilityId } from "./schema.js";

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

describe("persona manifest schema and registry", () => {
  it("loads Jeb as the sole enabled persona with immutable identity fields", () => {
    const registry = loadPersonaRegistry({
      repositoryRoot,
      manifestDir,
      enabledPersonaIds: ["jeb"],
    });
    const jeb = registry.get("jeb");
    expect(registry.list()).toHaveLength(1);
    expect(jeb.manifest.version).toBe("1.0.0");
    expect(jeb.manifestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(jeb)).toBe(true);
    expect(Object.isFrozen(jeb.manifest)).toBe(true);
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
    ).toThrow(/manifest not found/);
  });

  it("rejects duplicate persona ids", () => {
    const jeb = loadPersonaRegistry({
      repositoryRoot,
      manifestDir,
      enabledPersonaIds: ["jeb"],
    }).get("jeb");
    expect(() => new PersonaRegistry([jeb, jeb])).toThrow(/duplicate persona id/);
  });

  it("rejects unknown fields, path traversal, and namespace/version drift", () => {
    const valid = loadPersonaRegistry({
      repositoryRoot,
      manifestDir,
      enabledPersonaIds: ["jeb"],
    }).get("jeb").manifest;
    expect(PersonaManifestSchema.safeParse({ ...valid, extra: true }).success).toBe(false);
    expect(
      PersonaManifestSchema.safeParse({
        ...valid,
        identity: { ...valid.identity, profile_template: "../profile.json" },
      }).success,
    ).toBe(false);
    expect(
      PersonaManifestSchema.safeParse({
        ...valid,
        voice: { ...valid.voice, intro_line: "missing placeholder" },
      }).success,
    ).toBe(false);
    expect(
      PersonaManifestSchema.safeParse({
        ...valid,
        capabilities: { ...valid.capabilities, allow: ["not_a_capability"] },
      }).success,
    ).toBe(false);
  });

  it("rejects referenced-artifact drift and symlinked manifests", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jeb-persona-snapshot-"));
    temporaryDirectories.push(root);
    const copiedManifestDir = path.join(root, "personas");
    fs.mkdirSync(copiedManifestDir, { recursive: true });
    fs.cpSync(path.join(manifestDir, "jeb"), path.join(copiedManifestDir, "jeb"), { recursive: true });
    fs.appendFileSync(path.join(copiedManifestDir, "jeb", "persona.yaml"), "\n# mutated\n");
    expect(() =>
      loadPersonaRegistry({
        repositoryRoot: root,
        manifestDir: copiedManifestDir,
        enabledPersonaIds: ["jeb"],
      }),
    ).toThrow(/snapshot hash mismatch/);

    const outside = path.join(root, "outside.yaml");
    fs.writeFileSync(outside, "schema_version: 1\n");
    fs.mkdirSync(path.join(copiedManifestDir, "evil"));
    fs.symlinkSync(outside, path.join(copiedManifestDir, "evil", "persona.yaml"));
    expect(() =>
      loadPersonaRegistry({
        repositoryRoot: root,
        manifestDir: copiedManifestDir,
        enabledPersonaIds: ["evil"],
      }),
    ).toThrow(/manifest not found|symlink/);
  });
});

describe("persona capability catalogue", () => {
  it("defines every stable capability id exactly once", () => {
    expect(new Set(CAPABILITY_IDS).size).toBe(CAPABILITY_IDS.length);
  });

  it("expands only explicitly allowed Jeb tools", () => {
    const manifest = loadPersonaRegistry({
      repositoryRoot,
      manifestDir,
      enabledPersonaIds: ["jeb"],
    }).get("jeb").manifest;
    const resolved = resolveCapabilities(manifest);
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
    expect(manifestFieldPaths(runtimeManifestContract(snapshot.manifest))).toEqual(
      manifestFieldPaths(snapshot.manifest),
    );
    expect(Object.keys(MANIFEST_RUNTIME_CONSUMERS).sort()).toEqual(
      manifestFieldPaths(snapshot.manifest),
    );
    expect(Object.values(MANIFEST_RUNTIME_CONSUMERS).every(Boolean)).toBe(true);
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
            id: snapshot.manifest.id,
            version: snapshot.manifest.version,
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
            id: snapshot.manifest.id,
            version: snapshot.manifest.version,
            hash: "0".repeat(64),
          },
        },
        runtime,
      ),
    ).toThrow(/unknown or no longer available/);
    expect(() => assertWorkPersonaSnapshot({ mentionKey: "legacy" }, runtime)).toThrow(
      /missing a persona snapshot/,
    );
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
