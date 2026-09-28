import path from "node:path";
import type { Config } from "../config.js";
import { systemPrompt } from "../compose.js";
import type { ThreadPromptIdentity } from "../context.js";
import { identityDisclosure, longFormDisclosure } from "./disclosure.js";
import { resolveCapabilities, type ResolvedCapabilities } from "./capabilities.js";
import { loadPersonaRegistry, type RegisteredPersona } from "./registry.js";
import type { CapabilityId, PersonaManifest } from "./schema.js";

export interface RuntimePersona {
  snapshot: RegisteredPersona;
  capabilities: ResolvedCapabilities;
  systemPrompt: string;
  threadIdentity: ThreadPromptIdentity;
  identityDisclosure: string;
  longFormFooter: string;
}

export const MANIFEST_RUNTIME_CONSUMERS: Readonly<Record<string, string>> = {
  schema_version: "registry.schema_parser",
  id: "ingest.work_snapshot",
  version: "ingest.work_snapshot",
  "identity.display_name": "compose.system_prompt",
  "identity.operator": "compose.system_prompt",
  "identity.profile_template": "registry.profile_loader",
  "identity.policy_url": "answer.identity_source",
  "disclosure.kind": "profile_identity_longform_disclosure",
  "voice.assistant_role_label": "context.assistant_role",
  "voice.intro_line": "context.thread_intro",
  "capabilities.allow": "answer.capability_intersection",
};

export function runtimeManifestContract(manifest: PersonaManifest): PersonaManifest {
  return {
    schema_version: manifest.schema_version,
    id: manifest.id,
    version: manifest.version,
    identity: {
      display_name: manifest.identity.display_name,
      operator: manifest.identity.operator,
      profile_template: manifest.identity.profile_template,
      policy_url: manifest.identity.policy_url,
    },
    disclosure: {
      kind: manifest.disclosure.kind,
    },
    voice: {
      assistant_role_label: manifest.voice.assistant_role_label,
      intro_line: manifest.voice.intro_line,
    },
    capabilities: {
      allow: [...manifest.capabilities.allow],
    },
  };
}

export function personaThreadIdentity(manifest: PersonaManifest): ThreadPromptIdentity {
  return {
    assistantRoleLabel: manifest.voice.assistant_role_label,
    introLine: (botPk) => manifest.voice.intro_line.replaceAll("{bot_pk}", botPk),
  };
}

export function personaSystemPrompt(manifest: PersonaManifest, appUrl: string): string {
  return systemPrompt(appUrl, {
    displayName: manifest.identity.display_name,
    operator: manifest.identity.operator,
  });
}

export function createRuntimePersona(
  persona: RegisteredPersona,
  opts: { appUrl: string; deploymentAvailable?: ReadonlySet<CapabilityId> },
): RuntimePersona {
  const manifest = runtimeManifestContract(persona.manifest);
  return Object.freeze({
    snapshot: persona,
    capabilities: resolveCapabilities(manifest, opts.deploymentAvailable),
    systemPrompt: personaSystemPrompt(manifest, opts.appUrl),
    threadIdentity: personaThreadIdentity(manifest),
    identityDisclosure: identityDisclosure(manifest.disclosure.kind),
    longFormFooter: longFormDisclosure(manifest.disclosure.kind),
  });
}

export function matchesPersonaSnapshot(value: unknown, persona: RuntimePersona): boolean {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as { id?: unknown; version?: unknown; hash?: unknown };
  return (
    snapshot.id === persona.snapshot.manifest.id &&
    snapshot.version === persona.snapshot.manifest.version &&
    snapshot.hash === persona.snapshot.snapshotHash
  );
}

export function loadRuntimePersona(
  cfg: Pick<Config, "appUrl">,
  env: NodeJS.ProcessEnv = process.env,
): RuntimePersona {
  const repositoryRoot = path.resolve(env.JEB_PERSONA_REPOSITORY_ROOT?.trim() || process.cwd());
  const manifestDir = path.resolve(
    repositoryRoot,
    env.JEB_PERSONA_MANIFEST_DIR?.trim() || "personas",
  );
  const enabled = (env.JEB_ENABLED_PERSONAS ?? "jeb")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const defaultPersona = env.JEB_DEFAULT_PERSONA?.trim() || "jeb";
  const registry = loadPersonaRegistry({ repositoryRoot, manifestDir, enabledPersonaIds: enabled });
  const snapshot = registry.get(defaultPersona);
  return createRuntimePersona(snapshot, { appUrl: cfg.appUrl });
}
