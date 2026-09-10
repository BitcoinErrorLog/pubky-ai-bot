import { AuthFlowKind, Keypair, Pubky } from "@synonymdev/pubky";
import { listOwnedJsonPaths, type Transport } from "./homeserver.js";
import type { ResourceTargetProfile } from "./resource-target-profile.js";

/**
 * Bounded failure classes for the scoped publishing session. These strings are
 * the only session text allowed to reach a log, a manifest, or stderr: they
 * carry no authorization URL, no capability payload, and no SDK error text.
 */
export type ScopedSessionFailure =
  | "auth_flow_start_failed"
  | "authorization_url_missing"
  | "approval_denied"
  | "approval_timeout"
  | "approval_transport_failed"
  | "session_uninspectable"
  | "publisher_mismatch"
  | "capability_malformed"
  | "capability_action_forbidden"
  | "capability_too_broad"
  | "capability_out_of_scope"
  | "capability_extra_grant"
  | "capability_duplicate_grant"
  | "capability_not_covered"
  | "scoped_session_not_authorized_for_posts"
  | "scoped_session_not_authorized_for_bytes";

export class ScopedSessionError extends Error {
  constructor(readonly code: ScopedSessionFailure) {
    super(`scoped session refused: ${code}`);
    this.name = "ScopedSessionError";
  }
}

export type CapabilityVerdict = { ok: true; actions: "rw" } | { ok: false; code: ScopedSessionFailure };

interface ParsedGrant {
  scope: string;
  actions: string;
}

function parseGrant(entry: string): ParsedGrant | undefined {
  if (typeof entry !== "string") return undefined;
  const split = entry.lastIndexOf(":");
  if (split <= 0 || split === entry.length - 1) return undefined;
  const scope = entry.slice(0, split);
  const actions = entry.slice(split + 1);
  if (!scope.startsWith("/") || scope.includes("//") || scope.includes("..")) return undefined;
  if (actions.length > 2 || new Set(actions).size !== actions.length) return undefined;
  return { scope, actions };
}

/**
 * Coverage plus an independent maximum-authority bound.
 *
 * Coverage: the grants whose scope is exactly the required directory jointly
 * carry read and write. Authority bound: no grant may be broader than that
 * directory, outside it, or narrower than it — so `/:rw` is refused even
 * though it would cover the requirement.
 */
export function evaluateCapabilities(grants: readonly string[], requiredScope: string): CapabilityVerdict {
  if (!requiredScope.startsWith("/") || !requiredScope.endsWith("/")) {
    return { ok: false, code: "capability_malformed" };
  }
  if (!Array.isArray(grants) || grants.length === 0) return { ok: false, code: "capability_not_covered" };
  const covering: string[] = [];
  const normalized = new Set<string>();
  for (const entry of grants) {
    const grant = parseGrant(entry);
    if (!grant) return { ok: false, code: "capability_malformed" };
    if (/[^rw]/.test(grant.actions)) return { ok: false, code: "capability_action_forbidden" };
    const normalizedGrant = `${grant.scope}:${[...grant.actions].sort().join("")}`;
    if (normalized.has(normalizedGrant)) return { ok: false, code: "capability_duplicate_grant" };
    normalized.add(normalizedGrant);
    if (grant.scope === requiredScope) {
      covering.push(grant.actions);
      continue;
    }
    // A directory scope that the required scope sits under is strictly more
    // authority than policy allows.
    if (grant.scope.endsWith("/") && requiredScope.startsWith(grant.scope)) {
      return { ok: false, code: "capability_too_broad" };
    }
    if (grant.scope.startsWith(requiredScope)) return { ok: false, code: "capability_extra_grant" };
    return { ok: false, code: "capability_out_of_scope" };
  }
  const actions = new Set(covering.join(""));
  if (!actions.has("r") || !actions.has("w")) return { ok: false, code: "capability_not_covered" };
  return { ok: true, actions: "rw" };
}

export interface ScopedSessionStorage {
  putJson(path: string, json: unknown): Promise<void>;
  getJson(path: string): Promise<unknown>;
  delete(path: string): Promise<void>;
  list(
    path: string,
    cursor?: string | null,
    reverse?: boolean | null,
    limit?: number | null,
    shallow?: boolean | null,
  ): Promise<string[]>;
}

export interface ScopedSession {
  readonly info: { readonly publicKey: { z32(): string }; readonly capabilities: string[] };
  readonly storage: ScopedSessionStorage;
  signout(): Promise<void>;
}

export interface ScopedAuthFlow {
  readonly authorizationUrl: string;
  awaitApproval(): Promise<ScopedSession>;
}

/**
 * The narrow slice of the SDK the scoped session needs. `sdkScopedAuthPort`
 * is the only production implementation; the shape exists so the flow's
 * refusals can be driven without a live relay.
 */
export interface ScopedAuthPort {
  startSigninFlow(capabilities: string, relay: string): ScopedAuthFlow;
  approve(authorizationUrl: string): Promise<void>;
  resolveHomeserverPk(): Promise<string | undefined>;
}

export function sdkScopedAuthPort(pubky: Pubky, signer: ReturnType<Pubky["signer"]>): ScopedAuthPort {
  return {
    startSigninFlow: (capabilities, relay) =>
      pubky.startAuthFlow(capabilities as never, AuthFlowKind.signin(), relay) as unknown as ScopedAuthFlow,
    approve: (authorizationUrl) => signer.approveAuthRequest(authorizationUrl),
    resolveHomeserverPk: async () => (await signer.pkdns.getHomeserver())?.z32(),
  };
}

async function signoutQuietly(session: ScopedSession): Promise<void> {
  try {
    await session.signout();
  } catch {
    // A failed sign-out must not mask the refusal that caused it; the caller
    // already refuses the run and performs no mutation.
  }
}

function pending<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

function approvalFailure(error: unknown): ScopedSessionError {
  if (error instanceof ScopedSessionError) return error;
  const name = error instanceof Error ? error.name : "";
  if (name === "AuthenticationError") return new ScopedSessionError("approval_denied");
  return new ScopedSessionError("approval_transport_failed");
}

/**
 * `awaitApproval()` takes no timeout, so the deadline is raced against it. A
 * session that lands after the deadline is signed out instead of being left
 * authorized, and a late rejection is absorbed rather than surfacing as an
 * unhandled rejection.
 */
async function awaitApprovalWithin(approval: Promise<ScopedSession>, timeoutMs: number): Promise<ScopedSession> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new ScopedSessionError("approval_timeout");
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(new ScopedSessionError("approval_timeout"));
    }, timeoutMs);
  });
  const guarded = approval.then(
    async (session) => {
      if (!expired) return session;
      await signoutQuietly(session);
      return pending<ScopedSession>();
    },
    async (error) => {
      if (expired) return pending<ScopedSession>();
      throw approvalFailure(error);
    },
  );
  try {
    return await Promise.race([guarded, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Throws a bounded failure when the session is not exactly the scoped authority. */
export function assertSessionAuthority(session: ScopedSession, profile: ResourceTargetProfile): void {
  let publisherPk: string;
  let grants: string[];
  try {
    publisherPk = session.info.publicKey.z32();
    grants = [...session.info.capabilities];
  } catch {
    throw new ScopedSessionError("session_uninspectable");
  }
  if (typeof publisherPk !== "string" || publisherPk !== profile.publisherPk) {
    throw new ScopedSessionError("publisher_mismatch");
  }
  const verdict = evaluateCapabilities(grants, profile.tagCapabilityScope);
  if (!verdict.ok) throw new ScopedSessionError(verdict.code);
}

export interface ScopedSessionOptions {
  port: ScopedAuthPort;
  profile: ResourceTargetProfile;
  approvalTimeoutMs: number;
}

/**
 * Self-approved scoped session for `<tag scope>:rw`. There is no fallback to
 * the root `signer.signin()` path on any failure.
 */
export async function openScopedSession(opts: ScopedSessionOptions): Promise<ScopedSession> {
  const capabilities = `${opts.profile.tagCapabilityScope}:rw`;
  let flow: ScopedAuthFlow;
  try {
    flow = opts.port.startSigninFlow(capabilities, opts.profile.authRelayUrl);
  } catch {
    throw new ScopedSessionError("auth_flow_start_failed");
  }
  const approval = awaitApprovalWithin(flow.awaitApproval(), opts.approvalTimeoutMs);
  try {
    // Bearer-like channel material: read once, handed straight to the signer,
    // never stored, logged, returned, or included in an error.
    const authorizationUrl = flow.authorizationUrl;
    if (typeof authorizationUrl !== "string" || authorizationUrl.length === 0) {
      throw new ScopedSessionError("authorization_url_missing");
    }
    await opts.port.approve(authorizationUrl);
  } catch (error) {
    approval.catch(() => {});
    throw approvalFailure(error);
  }
  const session = await approval;
  try {
    assertSessionAuthority(session, opts.profile);
  } catch (error) {
    await signoutQuietly(session);
    throw error;
  }
  return session;
}

/**
 * `Transport` backed by the scoped session. Only the tag operations the
 * resource publisher uses are authorized; posts and raw-byte writes are
 * refused rather than attempted with authority the session does not hold.
 */
export class ScopedSessionTransport implements Transport {
  readonly botPk: string;
  resolvedHomeserverPk?: string;
  /**
   * The session and the auth port are ECMAScript private fields, not
   * TypeScript `private`: `JSON.stringify`, `Object.keys`, and object spread
   * cannot reach them, so an accidental serialization of this transport by a
   * logger or a manifest cannot walk into SDK objects or the auth channel.
   */
  #session: ScopedSession;
  readonly #opts: ScopedSessionOptions;

  constructor(session: ScopedSession, opts: ScopedSessionOptions, resolvedHomeserverPk?: string) {
    this.#session = session;
    this.#opts = opts;
    this.botPk = opts.profile.publisherPk;
    this.resolvedHomeserverPk = resolvedHomeserverPk;
  }

  async putJson(path: string, json: unknown): Promise<void> {
    await this.#session.storage.putJson(path, json);
  }

  async putBytes(): Promise<void> {
    throw new ScopedSessionError("scoped_session_not_authorized_for_bytes");
  }

  async getJson(path: string): Promise<unknown> {
    return this.#session.storage.getJson(path);
  }

  async deleteJson(path: string): Promise<void> {
    await this.#session.storage.delete(path);
  }

  async listJsonPaths(prefix: string): Promise<string[]> {
    return listOwnedJsonPaths(
      (listPath, cursor, limit) => this.#session.storage.list(listPath, cursor, false, limit, false),
      this.botPk,
      prefix,
    );
  }

  async listPosts(): Promise<Array<{ parent?: string; uri: string }>> {
    throw new ScopedSessionError("scoped_session_not_authorized_for_posts");
  }

  /** Re-mints the same scoped session; never the root signin path. */
  async reauth(): Promise<void> {
    const session = await openScopedSession(this.#opts);
    const previous = this.#session;
    this.#session = session;
    this.resolvedHomeserverPk = await this.#opts.port.resolveHomeserverPk();
    if (previous !== session) await signoutQuietly(previous);
  }

  async close(): Promise<void> {
    const session = this.#session;
    await signoutQuietly(session);
  }
}

export async function openScopedTransport(opts: ScopedSessionOptions): Promise<ScopedSessionTransport> {
  const session = await openScopedSession(opts);
  const resolvedHomeserverPk = await opts.port.resolveHomeserverPk();
  return new ScopedSessionTransport(session, opts, resolvedHomeserverPk);
}

/** Default deadline for the self-approval round trip through the relay. */
export const SCOPED_APPROVAL_TIMEOUT_MS = 30_000;

/**
 * The production entry point. It derives the keypair the same way the root
 * transport does and then never calls `signin()`: the only session this path
 * can produce is the scoped one, and a derived key that is not the profile's
 * publisher is refused before the auth flow starts.
 */
export async function openProductionScopedTransport(opts: {
  secretKeyHex: string;
  profile: ResourceTargetProfile;
  testnet: boolean;
  approvalTimeoutMs?: number;
}): Promise<ScopedSessionTransport> {
  const raw = Buffer.from(opts.secretKeyHex, "hex");
  if (raw.length !== 32) throw new ScopedSessionError("auth_flow_start_failed");
  let keypair: Keypair;
  try {
    keypair = Keypair.fromSecret(raw);
  } finally {
    raw.fill(0);
  }
  if (keypair.publicKey.z32() !== opts.profile.publisherPk) {
    throw new ScopedSessionError("publisher_mismatch");
  }
  const pubky = opts.testnet ? Pubky.testnet() : new Pubky();
  return openScopedTransport({
    port: sdkScopedAuthPort(pubky, pubky.signer(keypair)),
    profile: opts.profile,
    approvalTimeoutMs: opts.approvalTimeoutMs ?? SCOPED_APPROVAL_TIMEOUT_MS,
  });
}
