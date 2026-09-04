import { Keypair, Pubky, PublicKey } from "@synonymdev/pubky";
import { PubkyAppPostKind, PubkySpecsBuilder } from "pubky-app-specs";
import { isNotRegistered } from "./auth-error.js";
import { log } from "./log.js";
import { buildCollectionPost, buildStandalonePost, type CollectionLayout, type StandalonePostKind } from "./post.js";
import { POSTS_PREFIX } from "./types.js";

export interface Published {
  path: string;
  uri: string;
  json: Record<string, unknown>;
}

export interface Transport {
  botPk: string;
  putJson(path: string, json: unknown): Promise<void>;
  /** Raw bytes PUT (pubky-app HomeserverService.putBlob → session.storage.putBytes). No content-type header. */
  putBytes(path: string, body: Uint8Array): Promise<void>;
  getJson(path: string): Promise<unknown>;
  /** Delete a homeserver path (tag revoke). */
  deleteJson(path: string): Promise<void>;
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

export class SessionTransport implements Transport {
  constructor(
    readonly botPk: string,
    private session: Session,
    private readonly pubky: Pubky,
    private readonly signer: ReturnType<Pubky["signer"]>,
  ) {}

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

  async reauth(): Promise<void> {
    this.session = await this.signer.signin();
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
  return new SessionTransport(botPk, session, pubky, signer);
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
  const specs = new PubkySpecsBuilder(t.botPk);
  const kind = content.length > 2000 ? PubkyAppPostKind.Long : PubkyAppPostKind.Short;
  const { post, meta } = specs.createPost(
    content.slice(0, kind === PubkyAppPostKind.Long ? 50_000 : 2000),
    kind,
    parentUri,
    null,
    null,
  );
  const json = post.toJson() as Record<string, unknown>;
  const id = replacePostId?.trim().toUpperCase();
  const path = id ? `${POSTS_PREFIX}${id}` : meta.path;
  const uri = id ? `pubky://${t.botPk}${path}` : meta.url;
  await t.putJson(path, json);
  const read = await t.getJson(path);
  if (!read || typeof read !== "object") throw new Error("readback failed");
  return { path, uri, json };
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
