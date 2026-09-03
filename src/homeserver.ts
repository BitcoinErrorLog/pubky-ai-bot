import { Keypair, Pubky, PublicKey } from "@synonymdev/pubky";
import { PubkyAppPostKind, PubkySpecsBuilder } from "pubky-app-specs";
import { isNotRegistered } from "./auth-error.js";
import { POSTS_PREFIX } from "./types.js";

export interface Published {
  path: string;
  uri: string;
  json: Record<string, unknown>;
}

export interface Transport {
  botPk: string;
  putJson(path: string, json: unknown): Promise<void>;
  getJson(path: string): Promise<unknown>;
  listPosts(): Promise<Array<{ parent?: string; uri: string }>>;
  reauth(): Promise<void>;
}

type Session = Awaited<ReturnType<ReturnType<Pubky["signer"]>["signin"]>>;

class SessionTransport implements Transport {
  constructor(
    readonly botPk: string,
    private session: Session,
    private readonly pubky: Pubky,
    private readonly signer: ReturnType<Pubky["signer"]>,
  ) {}

  async putJson(path: string, json: unknown): Promise<void> {
    await this.session.storage.putJson(path as never, json);
  }

  async getJson(path: string): Promise<unknown> {
    return this.session.storage.getJson(path as never);
  }

  async reauth(): Promise<void> {
    this.session = await this.signer.signin();
  }

  async listPosts(): Promise<Array<{ parent?: string; uri: string }>> {
    const addr = `pubky${this.botPk}${POSTS_PREFIX}`;
    let listed: unknown;
    try {
      listed = await this.pubky.publicStorage.list(addr as never, null, false, 200, false);
    } catch {
      listed = [];
    }
    const urls = Array.isArray(listed) ? listed.map(String) : [];
    const out: Array<{ parent?: string; uri: string }> = [];
    for (const url of urls) {
      const id = url.split("/").filter(Boolean).pop();
      if (!id) continue;
      try {
        const json = (await this.pubky.publicStorage.getJson(url as never)) as { parent?: string };
        out.push({ parent: json.parent, uri: `pubky://${this.botPk}${POSTS_PREFIX}${id}` });
      } catch {
        continue;
      }
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
  let session: Session;
  try {
    session = await signer.signin();
  } catch (e) {
    if (!isNotRegistered(e) || !opts.signupToken || !opts.homeserverPk) throw e;
    const hs = PublicKey.from(opts.homeserverPk);
    session = await signer.signup(hs, opts.signupToken);
    delete process.env.JEB_SIGNUP_TOKEN;
    opts.signupToken = undefined;
  }
  return new SessionTransport(botPk, session, pubky, signer);
}

export function publicBotPk(secretKeyHex: string): string {
  const raw = Buffer.from(secretKeyHex, "hex");
  return Keypair.fromSecret(raw).publicKey.z32();
}

export async function publishReply(t: Transport, parentUri: string, content: string): Promise<Published> {
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
  await t.putJson(meta.path, json);
  const read = await t.getJson(meta.path);
  if (!read || typeof read !== "object") throw new Error("readback failed");
  return { path: meta.path, uri: meta.url, json };
}

export async function existingReply(t: Transport, parentUri: string): Promise<string | null> {
  const posts = await t.listPosts();
  return posts.find((p) => p.parent === parentUri)?.uri ?? null;
}
