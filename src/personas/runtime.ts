import path from "node:path";
import type { Config } from "../config.js";
import { systemPrompt } from "../compose.js";
import type { ThreadPromptIdentity } from "../context.js";
import { identityDisclosure, longFormDisclosure } from "./disclosure.js";
import { resolveCapabilities, type ResolvedCapabilities } from "./capabilities.js";
import { loadPersonaRegistry, type RegisteredPersona } from "./registry.js";
import type { CapabilityId, PersonaBinding, PersonaPack } from "./schema.js";

export interface RuntimePersona {
  snapshot: RegisteredPersona;
  capabilities: ResolvedCapabilities;
  systemPrompt: string;
  threadIdentity: ThreadPromptIdentity;
  identityDisclosure: string;
  longFormFooter: string;
}

export const PACK_RUNTIME_CONSUMERS: Readonly<Record<string, string>> = {
  schema_version: "registry.pack_schema",
  id: "ingest.work_snapshot",
  version: "ingest.work_snapshot",
  "disclosure.kind": "profile_identity_longform_disclosure",
  "voice.assistant_role_label": "context.assistant_role",
  "voice.intro_line": "context.thread_intro",
  "capabilities.allow": "answer.capability_intersection",
};

export const BINDING_RUNTIME_CONSUMERS: Readonly<Record<string, string>> = {
  schema_version: "registry.binding_schema",
  persona_id: "registry.pack_binding_match",
  pack_version: "registry.pack_binding_match",
  "identity.display_name": "compose.system_prompt",
  "identity.operator": "compose.system_prompt",
  "identity.profile_template": "registry.profile_loader",
  "identity.policy_url": "answer.identity_source",
};

export function runtimePackContract(pack: PersonaPack): PersonaPack {
  return {
    schema_version: pack.schema_version,
    id: pack.id,
    version: pack.version,
    disclosure: { kind: pack.disclosure.kind },
    voice: {
      assistant_role_label: pack.voice.assistant_role_label,
      intro_line: pack.voice.intro_line,
    },
    capabilities: { allow: [...pack.capabilities.allow] },
  };
}

export function runtimeBindingContract(binding: PersonaBinding): PersonaBinding {
  return {
    schema_version: binding.schema_version,
    persona_id: binding.persona_id,
    pack_version: binding.pack_version,
    identity: {
      display_name: binding.identity.display_name,
      operator: binding.identity.operator,
      profile_template: binding.identity.profile_template,
      policy_url: binding.identity.policy_url,
    },
  };
}

export function personaThreadIdentity(pack: PersonaPack): ThreadPromptIdentity {
  return {
    assistantRoleLabel: pack.voice.assistant_role_label,
    introLine: (botPk) => pack.voice.intro_line.replaceAll("{bot_pk}", botPk),
  };
}

export function personaSystemPrompt(pack: PersonaPack, binding: PersonaBinding, appUrl: string): string {
  void pack;
  return systemPrompt(appUrl, {
    displayName: binding.identity.display_name,
    operator: binding.identity.operator,
  });
}

export function createRuntimePersona(
  persona: RegisteredPersona,
  opts: { appUrl: string; deploymentAvailable?: ReadonlySet<CapabilityId> },
): RuntimePersona {
  const pack = runtimePackContract(persona.pack);
  const binding = runtimeBindingContract(persona.binding);
  return Object.freeze({
    snapshot: persona,
    capabilities: resolveCapabilities(pack, opts.deploymentAvailable),
    systemPrompt: personaSystemPrompt(pack, binding, opts.appUrl),
    threadIdentity: personaThreadIdentity(pack),
    identityDisclosure: identityDisclosure(pack.disclosure.kind),
    longFormFooter: longFormDisclosure(pack.disclosure.kind),
  });
}

export function matchesPersonaSnapshot(value: unknown, persona: RuntimePersona): boolean {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as { id?: unknown; version?: unknown; hash?: unknown };
  return (
    snapshot.id === persona.snapshot.pack.id &&
    snapshot.version === persona.snapshot.pack.version &&
    snapshot.hash === persona.snapshot.snapshotHash
  );
}

export function loadRuntimePersona(
  cfg: Pick<Config, "appUrl">,
  env: NodeJS.ProcessEnv = process.env,
): RuntimePersona {
  const repositoryRoot = path.resolve(env.JEB_PERSONA_REPOSITORY_ROOT?.trim() || process.cwd());
  const manifestDir = path.resolve(repositoryRoot, env.JEB_PERSONA_MANIFEST_DIR?.trim() || "personas");
  const enabled = (env.JEB_ENABLED_PERSONAS ?? "jeb").split(",").map((id) => id.trim()).filter(Boolean);
  const defaultPersona = env.JEB_DEFAULT_PERSONA?.trim() || "jeb";
  const registry = loadPersonaRegistry({ repositoryRoot, manifestDir, enabledPersonaIds: enabled });
  return createRuntimePersona(registry.get(defaultPersona), { appUrl: cfg.appUrl });
}
