import { CodedResourceError } from "./resource-error-code.js";

/**
 * Env contracts for the two resource processes.
 *
 * The planner is keyless and may hold the model key; the executor holds the
 * bot key and nothing else. Neither contract reads a value: presence by name
 * is the whole test, so a violation report can never quote a credential.
 */

/** Every name that has ever carried bot key material. */
export const KEY_SOURCE_ENV_NAMES = [
  "PUBKY_BOT_SECRET_KEY_HEX",
  "PUBKY_BOT_MNEMONIC",
  "PUBKY_BOT_SECRET_KEY_FILE",
] as const;

/**
 * Credentials the production publisher must not be able to reach. A signup or
 * admin token would let it create or administer identities; an exported
 * session is a bearer credential for the identity it already holds; the model
 * and web keys belong to the keyless planner process, not to the writer.
 */
export const EXECUTOR_FORBIDDEN_ENV_NAMES = [
  "JEB_SIGNUP_TOKEN",
  "ADMIN_TOKEN",
  "JEB_ADMIN_TOKEN",
  "JEB_MODEL_API_KEY",
  "JEB_EMBED_API_KEY",
  "JEB_BRAVE_API_KEY",
  "JEB_GITHUB_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "PUBKY_SESSION",
  "PUBKY_BOT_SESSION",
  "JEB_SESSION_TOKEN",
  "JEB_AUTH_URL",
] as const;

/** Credentials the keyless planner must not be able to reach. */
export const PLANNER_FORBIDDEN_ENV_NAMES = [
  "JEB_SIGNUP_TOKEN",
  "ADMIN_TOKEN",
  "JEB_ADMIN_TOKEN",
  "PUBKY_SESSION",
  "PUBKY_BOT_SESSION",
  "JEB_SESSION_TOKEN",
  "JEB_AUTH_URL",
] as const;

/**
 * Set, even to the empty string, counts as present.
 *
 * `assertNoKeyMaterial` tested truthiness, so `PUBKY_BOT_SECRET_KEY_FILE=""`
 * passed the guard while still telling an operator the process was meant to
 * be key-bearing. Under a production contract that ambiguity is itself the
 * defect: a deployment that names a credential variable it does not intend to
 * use must be corrected, not tolerated.
 */
function presentNames(env: NodeJS.ProcessEnv, names: readonly string[]): string[] {
  return names.filter((name) => env[name] !== undefined);
}

/** The keyless planner: no bot key at all, and no identity credentials. */
export function assertPlannerEnvContract(env: NodeJS.ProcessEnv = process.env): void {
  const present = [...presentNames(env, KEY_SOURCE_ENV_NAMES), ...presentNames(env, PLANNER_FORBIDDEN_ENV_NAMES)];
  if (present.length > 0) {
    throw new CodedResourceError("config_refused", `resource planner forbids: ${present.join(", ")}`);
  }
}

/**
 * The key-bearing executor: exactly one key source, non-empty, and no other
 * credential in the process. Two key sources are refused even when they would
 * resolve to the same identity, because the reader's priority order, not the
 * operator, would be choosing which one signs.
 */
export function assertExecutorEnvContract(env: NodeJS.ProcessEnv = process.env): void {
  const keySources = presentNames(env, KEY_SOURCE_ENV_NAMES);
  if (keySources.length === 0) {
    throw new CodedResourceError("config_refused", "resource executor requires exactly one key source");
  }
  if (keySources.length > 1) {
    throw new CodedResourceError("config_refused", `resource executor forbids a second key source: ${keySources.join(", ")}`);
  }
  const empty = keySources.filter((name) => (env[name] ?? "").trim() === "");
  if (empty.length > 0) {
    throw new CodedResourceError("config_refused", `resource executor key source is empty: ${empty.join(", ")}`);
  }
  const forbidden = presentNames(env, EXECUTOR_FORBIDDEN_ENV_NAMES);
  if (forbidden.length > 0) {
    throw new CodedResourceError("config_refused", `resource executor forbids: ${forbidden.join(", ")}`);
  }
}
