import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { parseManifest as parseKnowledgeManifest } from "../bot-kit/knowledge/manifest.js";
import { PersonaProfileTemplateSchema, type PersonaProfileTemplate } from "./profile-template.js";
import { PersonaManifestSchema, type PersonaManifest } from "./schema.js";
import { SourceRightsManifestSchema, type SourceRightsManifest } from "./source-rights.js";

export interface RegisteredPersona {
  manifest: PersonaManifest;
  manifestHash: string;
  snapshotHash: string;
  manifestPath: string;
  profile: PersonaProfileTemplate;
  voiceSpec: string;
  voiceEval: string;
  corpusManifest: string;
  rightsManifest: SourceRightsManifest;
}

export interface LoadPersonaRegistryOptions {
  repositoryRoot: string;
  manifestDir: string;
  enabledPersonaIds: readonly string[];
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function resolveBundleFile(bundleRoot: string, relativePath: string): string {
  const candidate = path.resolve(bundleRoot, relativePath);
  if (!isInside(bundleRoot, candidate)) {
    throw new Error(`persona reference escapes manifest directory: ${relativePath}`);
  }
  const stat = lstatSync(candidate);
  if (stat.isSymbolicLink()) throw new Error(`persona bundle files cannot be symlinks: ${relativePath}`);
  const real = realpathSync(candidate);
  if (!isInside(bundleRoot, real) || !statSync(real).isFile()) {
    throw new Error(`persona reference is not a manifest-directory file: ${relativePath}`);
  }
  return real;
}

function parseYamlFile<T>(
  filePath: string,
  parse: (value: unknown) => { success: true; data: T } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } },
  label: string,
): T {
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(filePath, "utf8"), { maxAliasCount: 20, uniqueKeys: true });
  } catch (error) {
    throw new Error(`invalid ${label} YAML ${filePath}: ${String(error)}`);
  }
  const result = parse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`invalid ${label} ${filePath}: ${issues}`);
  }
  return result.data;
}

function snapshotHash(files: ReadonlyArray<{ name: string; content: Buffer }>): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    hash.update(file.name, "utf8");
    hash.update("\0");
    hash.update(String(file.content.length), "utf8");
    hash.update("\0");
    hash.update(file.content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function assertPersonaRights(
  manifest: PersonaManifest,
  corpusText: string,
  rights: SourceRightsManifest,
): void {
  const denied = new Set(manifest.capabilities.deny);
  const personaKnowledgeEnabled =
    manifest.capabilities.allow.includes("knowledge_persona") && !denied.has("knowledge_persona");
  if (!personaKnowledgeEnabled) return;
  const corpus = parseKnowledgeManifest(corpusText);
  const rightsById = new Map(rights.sources.map((record) => [record.source_id, record]));
  for (const source of corpus.sources.filter((entry) => entry.enabled !== false)) {
    const record = rightsById.get(source.id);
    if (
      !record ||
      !record.allowed_uses.includes("retrieval") ||
      record.rights_status === "review_only" ||
      record.rights_status === "excluded"
    ) {
      throw new Error(`persona corpus source ${source.id} lacks retrieval-approved rights`);
    }
  }
}

function loadManifest(manifestDir: string, manifestPath: string): RegisteredPersona {
  if (lstatSync(manifestPath).isSymbolicLink()) {
    throw new Error(`persona manifests cannot be symlinks: ${manifestPath}`);
  }
  const bundleRoot = realpathSync(path.dirname(manifestPath));
  if (!isInside(manifestDir, bundleRoot)) throw new Error("persona manifest escapes manifest directory");
  const manifestBytes = readFileSync(manifestPath);
  const manifest = parseYamlFile(manifestPath, (value) => PersonaManifestSchema.safeParse(value), "persona manifest");
  const expectedId = path.basename(bundleRoot);
  if (manifest.id !== expectedId) {
    throw new Error(`persona manifest id ${manifest.id} does not match directory ${expectedId}`);
  }

  const profilePath = resolveBundleFile(bundleRoot, manifest.identity.profile_template);
  const voiceSpecPath = resolveBundleFile(bundleRoot, manifest.voice.spec);
  const voiceEvalPath = resolveBundleFile(bundleRoot, manifest.voice.eval_set);
  const corpusPath = resolveBundleFile(bundleRoot, manifest.expertise.corpus_manifest);
  const rightsPath = resolveBundleFile(bundleRoot, manifest.expertise.rights_manifest);
  const hashPath = resolveBundleFile(bundleRoot, "persona.snapshot.sha256");

  let profileJson: unknown;
  try {
    profileJson = JSON.parse(readFileSync(profilePath, "utf8"));
  } catch (error) {
    throw new Error(`invalid persona profile template ${profilePath}: ${String(error)}`);
  }
  const profile = PersonaProfileTemplateSchema.safeParse(profileJson);
  if (!profile.success) {
    const issues = profile.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`invalid persona profile template ${profilePath}: ${issues}`);
  }
  if (
    profile.data.name !== manifest.identity.display_name ||
    profile.data.disclosure_kind !== manifest.identity.kind
  ) {
    throw new Error(`persona profile template does not match identity for ${manifest.id}`);
  }

  const voiceSpecBytes = readFileSync(voiceSpecPath);
  const voiceEvalBytes = readFileSync(voiceEvalPath);
  const corpusBytes = readFileSync(corpusPath);
  const rightsBytes = readFileSync(rightsPath);
  const rights = parseYamlFile(rightsPath, (value) => SourceRightsManifestSchema.safeParse(value), "source-rights manifest");
  assertPersonaRights(manifest, corpusBytes.toString("utf8"), rights);

  const computedHash = snapshotHash([
    { name: "persona.yaml", content: manifestBytes },
    { name: manifest.identity.profile_template, content: readFileSync(profilePath) },
    { name: manifest.voice.spec, content: voiceSpecBytes },
    { name: manifest.voice.eval_set, content: voiceEvalBytes },
    { name: manifest.expertise.corpus_manifest, content: corpusBytes },
    { name: manifest.expertise.rights_manifest, content: rightsBytes },
  ]);
  const expectedHash = readFileSync(hashPath, "utf8").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expectedHash) || expectedHash !== computedHash) {
    throw new Error(`persona snapshot hash mismatch for ${manifest.id}`);
  }

  return deepFreeze({
    manifest,
    manifestHash: computedHash,
    snapshotHash: computedHash,
    manifestPath,
    profile: profile.data,
    voiceSpec: voiceSpecBytes.toString("utf8"),
    voiceEval: voiceEvalBytes.toString("utf8"),
    corpusManifest: corpusBytes.toString("utf8"),
    rightsManifest: rights,
  });
}

export class PersonaRegistry {
  readonly #byId: ReadonlyMap<string, RegisteredPersona>;
  readonly #byPublicKey: ReadonlyMap<string, RegisteredPersona>;

  constructor(personas: readonly RegisteredPersona[]) {
    const byId = new Map<string, RegisteredPersona>();
    const byPublicKey = new Map<string, RegisteredPersona>();
    for (const persona of personas) {
      if (byId.has(persona.manifest.id)) throw new Error(`duplicate persona id: ${persona.manifest.id}`);
      const keys = [
        persona.manifest.identity.public_key,
        ...persona.manifest.identity.non_production_public_keys,
      ];
      for (const key of keys) {
        const prior = byPublicKey.get(key);
        if (prior) {
          throw new Error(`persona public key belongs to both ${prior.manifest.id} and ${persona.manifest.id}`);
        }
        byPublicKey.set(key, persona);
      }
      byId.set(persona.manifest.id, persona);
    }
    this.#byId = byId;
    this.#byPublicKey = byPublicKey;
  }

  list(): readonly RegisteredPersona[] {
    return Object.freeze([...this.#byId.values()]);
  }

  get(id: string): RegisteredPersona {
    const persona = this.#byId.get(id);
    if (!persona) throw new Error(`unknown or disabled persona: ${id}`);
    return persona;
  }

  getByPublicKey(publicKey: string): RegisteredPersona {
    const persona = this.#byPublicKey.get(publicKey);
    if (!persona) throw new Error("public key is not registered to an enabled persona");
    return persona;
  }
}

export function loadPersonaRegistry(options: LoadPersonaRegistryOptions): PersonaRegistry {
  const repositoryRoot = realpathSync(options.repositoryRoot);
  const manifestDir = realpathSync(options.manifestDir);
  if (!isInside(repositoryRoot, manifestDir) || !statSync(manifestDir).isDirectory()) {
    throw new Error("persona manifest directory must be inside the repository root");
  }
  const requested = new Set(options.enabledPersonaIds);
  if (requested.size === 0) throw new Error("at least one persona must be enabled");
  if (requested.size !== options.enabledPersonaIds.length) throw new Error("enabled persona ids must be unique");

  const available = new Map<string, string>();
  for (const entry of readdirSync(manifestDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(manifestDir, entry.name, "persona.yaml");
    try {
      if (!lstatSync(manifestPath).isSymbolicLink() && statSync(manifestPath).isFile()) {
        available.set(entry.name, manifestPath);
      }
    } catch {
      // A directory without persona.yaml is not a persona.
    }
  }

  const personas = options.enabledPersonaIds.map((id) => {
    const manifestPath = available.get(id);
    if (!manifestPath) throw new Error(`enabled persona manifest not found: ${id}`);
    return loadManifest(manifestDir, manifestPath);
  });
  return new PersonaRegistry(personas);
}
