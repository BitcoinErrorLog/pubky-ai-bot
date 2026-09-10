import { Keypair, Pubky, PublicKey } from "@synonymdev/pubky";
import { isNotRegistered } from "../security/auth-error.js";
import { log } from "../log.js";
import { buildCollectionPost, buildReplyPost, buildStandalonePost, type CollectionLayout, type StandalonePostKind } from "./post.js";
import { POSTS_PREFIX } from "../types.js";

export interface Published {
  path: string;
  uri: string;
  json: Record<string, unknown>;
}

export interface Transport {
  botPk: string;
  /** Homeserver public key actually resolved for this session (pkarr / signup). */
  resolvedHomeserverPk?: string;
  /** Optional resolved homeserver HTTPS host when the client exposes one. */
  resolvedHomeserverHost?: string;
  putJson(path: string, json: unknown): Promise<void>;
  /** Raw bytes PUT (pubky-app HomeserverService.putBlob → session.storage.putBytes). No content-type header. */
  putBytes(path: string, body: Uint8Array): Promise<void>;
  getJson(path: string): Promise<unknown>;
  /** Delete a homeserver path (tag revoke). */
  deleteJson(path: string): Promise<void>;
  /** List JSON paths through the authenticated session, fully exhausted and bounded. */
  listJsonPaths?(prefix: string): Promise<string[]>;
  listPosts(opts?: { untilParent?: string }): Promise<Array<{ parent?: string; uri: string }>>;
  reauth(): Promise<void>;
}

/** Definitive "no posts directory yet" (first publish) — not a transient failure. */
export function isDirNotFound(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /404/.test(msg) && /directory not found/i.test(msg);
}

type Session = Awaited<ReturnType<ReturnType<Pubky["signer"]>["signin"]>>;

export type SigninSigner = {
  signin(): Promise<Session>;
  signup(homeserver: unknown, token: string): Promise<Session>;
};

/** Sign in, or signup once when the identity has no homeserver yet. */
export async function signinOrSignup(
  signer: SigninSigner,
  opts: { homeserverPk: string; signupToken?: string },
  botPk: string,
  resolveHomeserver: (pk: string) => unknown = (pk) => PublicKey.from(pk),
): Promise<Session> {
  try {
    return await signer.signin();
  } catch (e) {
    if (!isNotRegistered(e, botPk) || !opts.signupToken || !opts.homeserverPk) throw e;
    const session = await signer.signup(resolveHomeserver(opts.homeserverPk), opts.signupToken);
    delete process.env.JEB_SIGNUP_TOKEN;
    opts.signupToken = undefined;
    // R-05: signup consumes the single-use token — record that it happened.
    // Never log the token itself.
    log.info({ homeserver: opts.homeserverPk }, `signup performed for _pubky.${botPk}`);
    return session;
  }
}

async function resolvedHomeserverPkOf(signer: ReturnType<Pubky["signer"]>): Promise<string | undefined> {
  // Fresh pkarr/relay lookup (self-signed record), not the session's cached homeserver target.
  // Undefined is fail-closed for the resources publisher; other roles ignore the field.
  try {
    const pk = await signer.pkdns.getHomeserver();
    return pk?.z32();
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    log.warn(
      { errClass: err.name, errMessage: err.message },
      "getHomeserver failed; resolvedHomeserverPk left undefined",
    );
    return undefined;
  }
}

export type OwnedListPage = (path: string, cursor: string | null, limit: number) => Promise<unknown>;

/**
 * Exhaust a directory listing that must contain only this identity's paths
 * under an exact prefix. Shared by the root session transport and the scoped
 * resource transport so both enforce the identical ownership rules.
 */
export async function listOwnedJsonPaths(listPage: OwnedListPage, botPk: string, prefix: string): Promise<string[]> {
  const exactPrefix = prefix.endsWith("/") ? prefix : `${prefix}/`;
  const origin = `pubky://${botPk}`;
  const PAGE = 200;
  const MAX_PAGES = 25;
  const out: string[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const listed = await listPage(exactPrefix, cursor, PAGE);
    if (!Array.isArray(listed)) throw new Error("homeserver listing is malformed");
    if (listed.length === 0) return out;
    for (const raw of listed) {
      if (typeof raw !== "string" || !raw.startsWith(`${origin}/`)) {
        throw new Error("homeserver listing contains a path for another identity");
      }
      const path = raw.slice(origin.length);
      if (!path.startsWith(exactPrefix) || path.length <= exactPrefix.length) {
        throw new Error("homeserver listing contains malformed or out-of-prefix path");
      }
      if (seen.has(path)) throw new Error("homeserver listing contains duplicate path");
      seen.add(path);
      out.push(path);
    }
    if (listed.length < PAGE) return out;
    const next = listed[listed.length - 1]!;
    if (next === cursor) throw new Error("homeserver listing cursor did not advance");
    cursor = next;
  }
  throw new Error("homeserver listing exceeded page limit");
}

export class SessionTransport implements Transport {
  resolvedHomeserverPk?: string;

  constructor(
    readonly botPk: string,
    private session: Session,
    private readonly pubky: Pubky,
    private readonly signer: ReturnType<Pubky["signer"]>,
    resolvedHomeserverPk?: string,
  ) {
    this.resolvedHomeserverPk = resolvedHomeserverPk;
  }

  async putJson(path: string, json: unknown): Promise<void> {
    await this.session.storage.putJson(path as never, json);
  }

  async putBytes(path: string, body: Uint8Array): Promise<void> {
    await this.session.storage.putBytes(path as never, body);
  }

  async getJson(path: string): Promise<unknown> {
    return this.session.storage.getJson(path as never);
  }

  async deleteJson(path: string): Promise<void> {
    await this.session.storage.delete(path as never);
  }

  async listJsonPaths(prefix: string): Promise<string[]> {
    return listOwnedJsonPaths(
      (path, cursor, limit) => this.session.storage.list(path as never, cursor, false, limit, false),
      this.botPk,
      prefix,
    );
  }

  async reauth(): Promise<void> {
    this.session = await this.signer.signin();
    this.resolvedHomeserverPk = await resolvedHomeserverPkOf(this.signer);
  }

  /**
   * Lists posts under the bot's posts prefix, newest first, paging until the
   * listing is exhausted or `untilParent` is found (early exit). Errors
   * propagate: a failed listing must never be treated as "no posts" — the
   * idempotent republish reconcile depends on this (fail-closed; the publish
   * loop retries with backoff). The one exception is "directory not found":
   * before the first PUT the posts directory does not exist yet, which is a
   * definitive empty listing, not an unknown one.
   */
  async listPosts(opts?: { untilParent?: string }): Promise<Array<{ parent?: string; uri: string }>> {
    const addr = `pubky${this.botPk}${POSTS_PREFIX}`;
    const PAGE = 200;
    const MAX_PAGES = 25;
    const out: Array<{ parent?: string; uri: string }> = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      let listed: unknown;
      try {
        listed = await this.pubky.publicStorage.list(addr as never, cursor, true, PAGE, false);
      } catch (e) {
        if (isDirNotFound(e)) return out;
        throw e;
      }
      const urls = Array.isArray(listed) ? listed.map(String) : [];
      if (urls.length === 0) break;
      for (const url of urls) {
        const id = url.split("/").filter(Boolean).pop();
        if (!id) continue;
        const json = (await this.pubky.publicStorage.getJson(url as never)) as { parent?: string };
        const rec = { parent: json.parent, uri: `pubky://${this.botPk}${POSTS_PREFIX}${id}` };
        out.push(rec);
        if (opts?.untilParent && rec.parent === opts.untilParent) return out;
      }
      if (urls.length < PAGE) break;
      const next = urls[urls.length - 1] ?? null;
      if (!next || next === cursor) break;
      cursor = next;
    }
    return out;
  }
}

export async function openTransport(opts: {
  secretKeyHex: string;
  homeserverPk: string;
  signupToken?: string;
  testnet: boolean;
}): Promise<Transport> {
  const raw = Buffer.from(opts.secretKeyHex, "hex");
  if (raw.length !== 32) throw new Error("secret must be 32 bytes");
  const keypair = Keypair.fromSecret(raw);
  const botPk = keypair.publicKey.z32();
  const pubky = opts.testnet ? Pubky.testnet() : new Pubky();
  const signer = pubky.signer(keypair);
  const session = await signinOrSignup(signer, opts, botPk);
  const resolvedHomeserverPk = await resolvedHomeserverPkOf(signer);
  return new SessionTransport(botPk, session, pubky, signer, resolvedHomeserverPk);
}

export function publicBotPk(secretKeyHex: string): string {
  const raw = Buffer.from(secretKeyHex, "hex");
  return Keypair.fromSecret(raw).publicKey.z32();
}

export async function publishReply(
  t: Transport,
  parentUri: string,
  content: string,
  replacePostId?: string | null,
): Promise<Published> {
  const built = buildReplyPost(t.botPk, parentUri, content, replacePostId);
  await t.putJson(built.path, built.json);
  const read = await t.getJson(built.path);
  if (!read || typeof read !== "object") throw new Error("readback failed");
  return { path: built.path, uri: built.uri, json: built.json };
}

export async function existingReply(t: Transport, parentUri: string): Promise<string | null> {
  const posts = await t.listPosts({ untilParent: parentUri });
  return posts.find((p) => p.parent === parentUri)?.uri ?? null;
}

/** PUT a standalone (non-reply) post at a caller-chosen 13-char id so retries overwrite. */
export async function publishStandalone(
  t: Transport,
  content: string,
  kind: StandalonePostKind,
  postId: string,
  attachments: string[] | null,
): Promise<Published> {
  const built = buildStandalonePost(t.botPk, content, kind, attachments, postId);
  await t.putJson(built.path, built.json);
  const read = await t.getJson(built.path);
  if (!read || typeof read !== "object") throw new Error("readback failed");
  return { path: built.path, uri: built.url, json: built.json };
}

/** PUT a kind=collection post at a deterministic id so retries and upserts overwrite. */
export async function publishCollection(
  t: Transport,
  opts: { title: string; description: string; itemUris: string[]; layout?: CollectionLayout },
  postId: string,
): Promise<Published> {
  const built = buildCollectionPost(t.botPk, opts, postId);
  await t.putJson(built.path, built.json);
  const read = await t.getJson(built.path);
  if (!read || typeof read !== "object") throw new Error("readback failed");
  return { path: built.path, uri: built.url, json: built.json };
}
