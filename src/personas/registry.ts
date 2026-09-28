import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { PersonaProfileTemplateSchema, type PersonaProfileTemplate } from "./profile-template.js";
import { loadPersonaPack, type LoadedPersonaPack } from "./pack-loader.js";
import {
  PersonaBindingSchema,
  type PersonaBinding,
} from "./schema.js";

export interface RegisteredPersona extends LoadedPersonaPack {
  binding: PersonaBinding;
  bindingHash: string;
  snapshotHash: string;
  bindingPath: string;
  profile: PersonaProfileTemplate;
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
  if (!isInside(bundleRoot, candidate)) throw new Error(`persona reference escapes bundle: ${relativePath}`);
  const stat = lstatSync(candidate);
  if (stat.isSymbolicLink()) throw new Error(`persona bundle files cannot be symlinks: ${relativePath}`);
  const real = realpathSync(candidate);
  if (!isInside(bundleRoot, real) || !statSync(real).isFile()) {
    throw new Error(`persona reference is not a bundle file: ${relativePath}`);
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

function contentHash(files: ReadonlyArray<{ name: string; content: Buffer }>): string {
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

function verifyHash(filePath: string, computed: string, label: string): void {
  const expected = readFileSync(filePath, "utf8").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected) || expected !== computed) {
    throw new Error(`${label} hash mismatch`);
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function loadRegisteredPersona(manifestDir: string, bundleRoot: string): RegisteredPersona {
  if (!isInside(manifestDir, bundleRoot)) throw new Error("persona bundle escapes manifest directory");
  const loaded = loadPersonaPack(resolveBundleFile(bundleRoot, "pack.yaml"));
  const bindingPath = resolveBundleFile(bundleRoot, "binding.yaml");
  const bindingBytes = readFileSync(bindingPath);
  const binding = parseYamlFile(
    bindingPath,
    (value) => PersonaBindingSchema.safeParse(value),
    "persona binding",
  );
  if (binding.persona_id !== loaded.pack.id || binding.pack_version !== loaded.pack.version) {
    throw new Error(`persona binding does not match pack ${loaded.pack.id}@${loaded.pack.version}`);
  }

  const profilePath = resolveBundleFile(bundleRoot, binding.identity.profile_template);
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
    profile.data.name !== binding.identity.display_name ||
    profile.data.disclosure_kind !== loaded.pack.disclosure.kind
  ) {
    throw new Error(`persona profile template does not match ${loaded.pack.id} binding`);
  }

  const profileBytes = readFileSync(profilePath);
  const bindingHash = contentHash([
    { name: "binding.yaml", content: bindingBytes },
    { name: binding.identity.profile_template, content: profileBytes },
  ]);
  const snapshotHash = contentHash([
    { name: "pack.yaml", content: readFileSync(loaded.packPath) },
    { name: "binding.yaml", content: bindingBytes },
    { name: binding.identity.profile_template, content: profileBytes },
  ]);
  verifyHash(resolveBundleFile(bundleRoot, "persona.snapshot.sha256"), snapshotHash, `persona ${loaded.pack.id}`);
  return deepFreeze({
    ...loaded,
    binding,
    bindingHash,
    snapshotHash,
    bindingPath,
    profile: profile.data,
  });
}

export class PersonaRegistry {
  readonly #byId: ReadonlyMap<string, RegisteredPersona>;

  constructor(personas: readonly RegisteredPersona[]) {
    const byId = new Map<string, RegisteredPersona>();
    for (const persona of personas) {
      if (byId.has(persona.pack.id)) throw new Error(`duplicate persona id: ${persona.pack.id}`);
      byId.set(persona.pack.id, persona);
    }
    this.#byId = byId;
  }

  list(): readonly RegisteredPersona[] {
    return Object.freeze([...this.#byId.values()]);
  }

  get(id: string): RegisteredPersona {
    const persona = this.#byId.get(id);
    if (!persona) throw new Error(`unknown or disabled persona: ${id}`);
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

  const bundles = new Map<string, string>();
  for (const entry of readdirSync(manifestDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const bundleRoot = path.join(manifestDir, entry.name);
    try {
      if (
        statSync(path.join(bundleRoot, "pack.yaml")).isFile() &&
        statSync(path.join(bundleRoot, "binding.yaml")).isFile()
      ) {
        bundles.set(entry.name, realpathSync(bundleRoot));
      }
    } catch {
      // A directory without both pack and binding is not an enabled account.
    }
  }

  return new PersonaRegistry(options.enabledPersonaIds.map((id) => {
    const bundleRoot = bundles.get(id);
    if (!bundleRoot) throw new Error(`enabled persona pack/binding not found: ${id}`);
    return loadRegisteredPersona(manifestDir, bundleRoot);
  }));
}
