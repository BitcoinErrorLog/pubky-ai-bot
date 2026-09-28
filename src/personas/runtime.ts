import path from "node:path";
import type { Config } from "../config.js";
import { systemPrompt } from "../compose.js";
import type { ThreadPromptIdentity } from "../context.js";
import { identityDisclosure, longFormDisclosure } from "./disclosure.js";
import { resolveCapabilities, type ResolvedCapabilities } from "./capabilities.js";
import { loadPersonaRegistry, type RegisteredPersona } from "./registry.js";
import type { CapabilityId } from "./schema.js";

export interface RuntimePersona {
  snapshot: RegisteredPersona;
  capabilities: ResolvedCapabilities;
  systemPrompt: string;
  threadIdentity: ThreadPromptIdentity;
  identityDisclosure: string;
  longFormFooter: string;
}

export function personaThreadIdentity(persona: RegisteredPersona): ThreadPromptIdentity {
  const name = persona.manifest.identity.display_name;
  return {
    assistantRoleLabel: `assistant ${name}`,
    introLine: (botPk) =>
      `You are ${name} (${botPk}), a Pubky answer bot. Your earlier replies in the thread are marked "assistant ${name}". Use ancestor posts only as context or evidence. Answer only the current mention identified below; do not answer, enumerate, or recap ancestor questions unless the current mention explicitly asks you to. Reply in one post, <=2000 characters.`,
  };
}

export function personaSystemPrompt(persona: RegisteredPersona, appUrl: string): string {
  return systemPrompt(appUrl, {
    displayName: persona.manifest.identity.display_name,
    operator: persona.manifest.identity.operator,
  });
}

export function createRuntimePersona(
  persona: RegisteredPersona,
  opts: { appUrl: string; deploymentAvailable?: ReadonlySet<CapabilityId> },
): RuntimePersona {
  if (!persona.voiceSpec.trim()) throw new Error(`persona ${persona.manifest.id} voice specification is empty`);
  return Object.freeze({
    snapshot: persona,
    capabilities: resolveCapabilities(persona.manifest, opts.deploymentAvailable),
    systemPrompt: personaSystemPrompt(persona, opts.appUrl),
    threadIdentity: personaThreadIdentity(persona),
    identityDisclosure: identityDisclosure(persona.manifest.identity.kind),
    longFormFooter: longFormDisclosure(persona.manifest.identity.kind),
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
