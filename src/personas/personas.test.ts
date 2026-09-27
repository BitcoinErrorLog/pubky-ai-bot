import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { FULL_TOOLS } from "../intent.js";
import { JEB_THREAD_IDENTITY } from "../context.js";
import { composeReply, systemPrompt } from "../compose.js";
import { assertWorkPersonaSnapshot } from "../reason.js";
import {
  assertPersonaToolExecution,
  resolveCapabilities,
  selectPersonaToolNames,
} from "./capabilities.js";
import {
  AI_PORTRAYAL_IDENTITY_DISCLOSURE,
  AI_PORTRAYAL_PROFILE_DISCLOSURE,
  AI_ROLE_PROFILE_DISCLOSURE,
} from "./disclosure.js";
import { assertPersonaRights, loadPersonaRegistry, PersonaRegistry } from "./registry.js";
import { createRuntimePersona } from "./runtime.js";
import { CAPABILITY_IDS, PersonaManifestSchema, type CapabilityId } from "./schema.js";
import { SourceRightsRecordSchema } from "./source-rights.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const manifestDir = path.join(repositoryRoot, "personas");
const temporaryDirectories: string[] = [];

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
    expect(jeb.manifest.identity.public_key).toBe(
      "9o6xrx8wgqu48dmb47uep6w3dgbwdnf5jgw83gbeuxg9yi7x444y",
    );
    expect(jeb.manifest.expertise.retrieval_namespace).toBe("persona/jeb/1.0.0");
    expect(jeb.manifestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(registry.getByPublicKey(jeb.manifest.identity.public_key)).toBe(jeb);
    expect(registry.getByPublicKey("iamjir7im98qnwu3t45zohk7ir5w9wx71679w6e9so6eiq8sriwo")).toBe(jeb);
    expect(Object.isFrozen(jeb)).toBe(true);
    expect(Object.isFrozen(jeb.manifest)).toBe(true);
    expect(Object.isFrozen(jeb.profile)).toBe(true);
    expect(fs.readFileSync(path.join(repositoryRoot, "sources.yaml"), "utf8")).toBe(jeb.corpusManifest);
  });

  it("fails closed for unknown or disabled personas and keys", () => {
    const registry = loadPersonaRegistry({
      repositoryRoot,
      manifestDir,
      enabledPersonaIds: ["jeb"],
    });
    expect(() => registry.get("unknown")).toThrow(/unknown or disabled persona/);
    expect(() => registry.getByPublicKey("a".repeat(52))).toThrow(/not registered/);
    expect(() =>
      loadPersonaRegistry({ repositoryRoot, manifestDir, enabledPersonaIds: ["unknown"] }),
    ).toThrow(/manifest not found/);
  });

  it("rejects duplicate public keys", () => {
    const jeb = loadPersonaRegistry({
      repositoryRoot,
      manifestDir,
      enabledPersonaIds: ["jeb"],
    }).get("jeb");
    const duplicate = {
      ...jeb,
      manifest: { ...jeb.manifest, id: "jeb-copy" },
    };
    expect(() => new PersonaRegistry([jeb, duplicate])).toThrow(/public key belongs to both/);
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
        voice: { ...valid.voice, spec: "../voice.md" },
      }).success,
    ).toBe(false);
    expect(
      PersonaManifestSchema.safeParse({
        ...valid,
        expertise: { ...valid.expertise, retrieval_namespace: "persona/jeb/2.0.0" },
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
    fs.appendFileSync(path.join(copiedManifestDir, "jeb", "voice.md"), "\nmutated\n");
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

  it("expands typed Jeb tools while deny wins over allow", () => {
    const manifest = loadPersonaRegistry({
      repositoryRoot,
      manifestDir,
      enabledPersonaIds: ["jeb"],
    }).get("jeb").manifest;
    const resolved = resolveCapabilities({
      capabilities: {
        allow: [...manifest.capabilities.allow, "raw_scout_query"],
        deny: manifest.capabilities.deny,
      },
    });
    expect(resolved.enabled.has("scout_graph")).toBe(true);
    expect(resolved.tools.has("get_emerging_topics")).toBe(true);
    expect(resolved.tools.has("search_knowledge")).toBe(true);
    expect(resolved.enabled.has("raw_scout_query")).toBe(false);
    expect(resolved.tools.has("query_graph")).toBe(false);
  });

  it("intersects manifest grants with deployment availability", () => {
    const resolved = resolveCapabilities(
      { capabilities: { allow: ["nexus_read", "web_search"], deny: [] } },
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
    expect(runtime.systemPrompt).toBe(systemPrompt("https://pubky.app"));
    expect(runtime.threadIdentity.assistantRoleLabel).toBe(JEB_THREAD_IDENTITY.assistantRoleLabel);
    expect(runtime.threadIdentity.introLine(snapshot.manifest.identity.public_key)).toBe(
      JEB_THREAD_IDENTITY.introLine(snapshot.manifest.identity.public_key),
    );
    const available = [...FULL_TOOLS, "search_knowledge", "search_persona_knowledge"];
    const selected = selectPersonaToolNames(new Set(FULL_TOOLS), available, runtime.capabilities);
    expect(selected).toEqual([
      ...FULL_TOOLS.filter((tool) => tool !== "query_graph"),
      "search_knowledge",
    ]);
    expect(() => assertPersonaToolExecution("query_graph", runtime.capabilities)).toThrow(/denied/);
    expect(() => assertPersonaToolExecution("search_persona_knowledge", runtime.capabilities)).toThrow(/denied/);
    expect(() =>
      assertWorkPersonaSnapshot(
        {
          persona: {
            id: snapshot.manifest.id,
            version: snapshot.manifest.version,
            hash: snapshot.snapshotHash,
            targetBotPk: snapshot.manifest.identity.public_key,
          },
        },
        runtime,
        snapshot.manifest.identity.public_key,
      ),
    ).not.toThrow();
    expect(() =>
      assertWorkPersonaSnapshot(
        {
          persona: {
            id: snapshot.manifest.id,
            version: snapshot.manifest.version,
            hash: "0".repeat(64),
            targetBotPk: snapshot.manifest.identity.public_key,
          },
        },
        runtime,
        snapshot.manifest.identity.public_key,
      ),
    ).toThrow(/unknown or no longer available/);
    expect(
      composeReply("A detailed answer.", new Set(["deep"]), [], {
        longFormFooter: runtime.longFormFooter,
      }).content,
    ).toContain(runtime.longFormFooter);
  });
});

describe("persona source-rights record", () => {
  const baseRecord = {
    schema_version: 1 as const,
    source_id: "example-primary-source",
    title: "Example primary source",
    author: "Example author",
    work_date: "2009",
    edition: null,
    translator: null,
    source_url: "https://example.com/source",
    retrieved_at: "2026-09-27T10:00:00.000Z",
    license: "Example permissive license",
    jurisdiction: "Worldwide commercial use",
    rights_status: "permissive_license" as const,
    allowed_uses: ["retrieval", "minimal_quotation"] as const,
    reviewed_by: "rights-reviewer",
    reviewed_at: "2026-09-27T10:01:00.000Z",
    notes: null,
  };

  it("accepts a complete reviewed record", () => {
    expect(SourceRightsRecordSchema.parse(baseRecord).source_id).toBe(baseRecord.source_id);
  });

  it("rejects retrieval or training for review-only material", () => {
    const result = SourceRightsRecordSchema.safeParse({
      ...baseRecord,
      rights_status: "review_only",
      allowed_uses: ["retrieval"],
    });
    expect(result.success).toBe(false);
  });

  it("requires retrieval-approved rights for every enabled persona corpus source", () => {
    const manifest = loadPersonaRegistry({
      repositoryRoot,
      manifestDir,
      enabledPersonaIds: ["jeb"],
    }).get("jeb").manifest;
    const personaManifest = {
      ...manifest,
      capabilities: {
        allow: [...manifest.capabilities.allow, "knowledge_persona" as const],
        deny: manifest.capabilities.deny.filter((id) => id !== "knowledge_persona"),
      },
    };
    const corpus = `
sources:
  - id: persona-source
    product: persona
    component: corpus
    kind: git
    location: https://github.com/BitcoinErrorLog/pubky-knowledge-base
    include: ["personas/jeb/**"]
    exclude: []
    status: canonical
    audience: user
    confidentiality: public
    owner: synonym
`;
    expect(() =>
      assertPersonaRights(personaManifest, corpus, { schema_version: 1, sources: [] }),
    ).toThrow(/lacks retrieval-approved rights/);
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
