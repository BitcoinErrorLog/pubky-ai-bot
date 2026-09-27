import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveCapabilities } from "./capabilities.js";
import {
  AI_PORTRAYAL_IDENTITY_DISCLOSURE,
  AI_PORTRAYAL_PROFILE_DISCLOSURE,
  AI_ROLE_PROFILE_DISCLOSURE,
} from "./disclosure.js";
import { loadPersonaRegistry, PersonaRegistry } from "./registry.js";
import { CAPABILITY_IDS, PersonaManifestSchema, type CapabilityId } from "./schema.js";
import { SourceRightsRecordSchema } from "./source-rights.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const manifestDir = path.join(repositoryRoot, "personas");

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
