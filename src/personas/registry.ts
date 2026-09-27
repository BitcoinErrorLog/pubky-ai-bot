import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { PersonaProfileTemplateSchema } from "./profile-template.js";
import { PersonaManifestSchema, type PersonaManifest } from "./schema.js";

export interface RegisteredPersona {
  manifest: PersonaManifest;
  manifestHash: string;
  manifestPath: string;
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

function resolveRepositoryFile(repositoryRoot: string, relativePath: string): string {
  const candidate = path.resolve(repositoryRoot, relativePath);
  if (!isInside(repositoryRoot, candidate)) {
    throw new Error(`persona reference escapes repository root: ${relativePath}`);
  }
  const real = realpathSync(candidate);
  if (!isInside(repositoryRoot, real) || !statSync(real).isFile()) {
    throw new Error(`persona reference is not a repository file: ${relativePath}`);
  }
  return real;
}

function loadManifest(repositoryRoot: string, manifestPath: string): RegisteredPersona {
  const raw = readFileSync(manifestPath, "utf8");
  let parsed: unknown;
  try {
    parsed = parseYaml(raw, { maxAliasCount: 20, uniqueKeys: true });
  } catch (error) {
    throw new Error(`invalid persona YAML ${manifestPath}: ${String(error)}`);
  }
  const result = PersonaManifestSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`invalid persona manifest ${manifestPath}: ${issues}`);
  }
  const manifest = result.data;
  const expectedId = path.basename(path.dirname(manifestPath));
  if (manifest.id !== expectedId) {
    throw new Error(`persona manifest id ${manifest.id} does not match directory ${expectedId}`);
  }
  const profilePath = resolveRepositoryFile(repositoryRoot, manifest.identity.profile_template);
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
  resolveRepositoryFile(repositoryRoot, manifest.voice.spec);
  resolveRepositoryFile(repositoryRoot, manifest.voice.eval_set);
  resolveRepositoryFile(repositoryRoot, manifest.expertise.corpus_manifest);
  return {
    manifest,
    manifestHash: createHash("sha256").update(raw, "utf8").digest("hex"),
    manifestPath,
  };
}

export class PersonaRegistry {
  readonly #byId: ReadonlyMap<string, RegisteredPersona>;
  readonly #byPublicKey: ReadonlyMap<string, RegisteredPersona>;

  constructor(personas: readonly RegisteredPersona[]) {
    const byId = new Map<string, RegisteredPersona>();
    const byPublicKey = new Map<string, RegisteredPersona>();
    for (const persona of personas) {
      if (byId.has(persona.manifest.id)) {
        throw new Error(`duplicate persona id: ${persona.manifest.id}`);
      }
      const priorKeyOwner = byPublicKey.get(persona.manifest.identity.public_key);
      if (priorKeyOwner) {
        throw new Error(
          `persona public key belongs to both ${priorKeyOwner.manifest.id} and ${persona.manifest.id}`,
        );
      }
      byId.set(persona.manifest.id, persona);
      byPublicKey.set(persona.manifest.identity.public_key, persona);
    }
    this.#byId = byId;
    this.#byPublicKey = byPublicKey;
  }

  list(): readonly RegisteredPersona[] {
    return [...this.#byId.values()];
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
  if (requested.size !== options.enabledPersonaIds.length) {
    throw new Error("enabled persona ids must be unique");
  }

  const available = new Map<string, string>();
  for (const entry of readdirSync(manifestDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(manifestDir, entry.name, "persona.yaml");
    try {
      if (statSync(manifestPath).isFile()) available.set(entry.name, manifestPath);
    } catch {
      // A directory without persona.yaml is not a persona.
    }
  }

  const personas: RegisteredPersona[] = [];
  for (const id of requested) {
    const manifestPath = available.get(id);
    if (!manifestPath) throw new Error(`enabled persona manifest not found: ${id}`);
    personas.push(loadManifest(repositoryRoot, manifestPath));
  }
  return new PersonaRegistry(personas);
}
