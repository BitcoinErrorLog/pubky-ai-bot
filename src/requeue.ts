import type { Config } from "./config.js";
import { Store } from "./db.js";
import { Nexus } from "./nexus.js";
import { extractPubkey, parsePostUri, type MentionKind, type PostView } from "./types.js";

export function mentionUrisFromArgv(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--mention") {
      const v = argv[i + 1];
      if (v && !v.startsWith("-")) out.push(v);
    }
  }
  return out;
}

export function replaceFlagFromArgv(argv: string[]): boolean {
  return argv.includes("--replace");
}

export function replyUriFromArgv(argv: string[]): string | undefined {
  const i = argv.indexOf("--reply");
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (!v || v.startsWith("-")) throw new Error("--reply requires a post URI");
  return v;
}

export function classifyRequeueKind(post: PostView, botPk: string): MentionKind | null {
  const parentUri = post.relationships?.replied ?? null;
  if (parentUri) {
    try {
      if (parsePostUri(parentUri).author === botPk) return "reply";
    } catch {
      /* parent is not a canonical post URI */
    }
  }
  const mentioned = (post.relationships?.mentioned ?? []).map((m) => extractPubkey(m));
  if (mentioned.includes(botPk) || post.details.content.includes(botPk)) return "mention";
  return null;
}

function replyAuthorIsBot(replyUri: string, botPk: string): boolean {
  return parsePostUri(replyUri).author.toLowerCase() === botPk.toLowerCase();
}

export async function requeueOne(args: {
  uri: string;
  store: Store;
  fetchPost: (uri: string) => Promise<PostView | null>;
  botPk: string;
  replace?: boolean;
  replyOverride?: string;
}): Promise<{ line: string; ok: boolean }> {
  const trimmed = args.uri.trim();
  try {
    parsePostUri(trimmed);
  } catch {
    return { line: `skipped ${trimmed}: not a canonical post URI`, ok: false };
  }
  let post: PostView | null;
  try {
    post = await args.fetchPost(trimmed);
  } catch (e) {
    const reason = e instanceof Error ? e.message : "fetch failed";
    return { line: `skipped ${trimmed}: ${reason}`, ok: false };
  }
  if (!post) return { line: `skipped ${trimmed}: not found`, ok: false };
  const kind = classifyRequeueKind(post, args.botPk);
  if (!kind) return { line: `skipped ${trimmed}: not addressed to bot`, ok: false };
  const author = post.details.author;

  let replacePostId: string | undefined;
  let replaceReplyUri: string | undefined;
  if (args.replace) {
    const stored = await args.store.get(trimmed);
    let replyUri = args.replyOverride?.trim() || stored?.reply_uri || "";
    if (!replyUri) {
      return {
        line: `skipped ${trimmed}: --replace needs a stored reply_uri or --reply <uri>`,
        ok: false,
      };
    }
    try {
      parsePostUri(replyUri);
    } catch {
      return { line: `skipped ${trimmed}: reply URI is not canonical`, ok: false };
    }
    if (!replyAuthorIsBot(replyUri, args.botPk)) {
      return { line: `skipped ${trimmed}: stored reply is not authored by the bot key`, ok: false };
    }
    replaceReplyUri = replyUri;
    replacePostId = parsePostUri(replyUri).postId.toUpperCase();
    await args.store.supersedePublishForReplace(trimmed);
    await args.store.reopenMentionForReplace(trimmed, author, args.botPk);
    const payload = { mentionKey: trimmed, replace_post_id: replacePostId };
    const inserted = await args.store.enqueueWork(trimmed, author, kind, payload);
    if (!inserted) await args.store.mergeWorkPayload(trimmed, payload);
    return { line: `requeued ${trimmed} replacing ${replaceReplyUri}`, ok: true };
  }

  const reopened = await args.store.reopenMentionForRequeue(trimmed, author, args.botPk);
  if (reopened === "published") return { line: `skipped ${trimmed}: already published`, ok: false };
  await args.store.enqueueWork(trimmed, author, kind, { mentionKey: trimmed });
  return { line: `requeued ${trimmed}`, ok: true };
}

export async function runRequeue(
  cfg: Config,
  uris: string[],
  opts?: { replace?: boolean; replyUri?: string },
): Promise<{ lines: string[]; ok: boolean }> {
  if (!cfg.botPk) throw new Error("JEB_BOT_PK required for requeue");
  if (uris.length === 0) {
    return { lines: ["skipped : missing --mention"], ok: false };
  }
  if (opts?.replyUri && !opts.replace) {
    return { lines: ["skipped : --reply requires --replace"], ok: false };
  }
  if (opts?.replyUri && uris.length > 1) {
    return { lines: ["skipped : --reply applies to a single --mention"], ok: false };
  }
  const store = new Store(cfg.databaseUrl);
  await store.migrate();
  const nexus = new Nexus(cfg.nexusUrl, cfg.nexusTimeoutMs);
  try {
    const lines: string[] = [];
    let ok = true;
    for (const uri of uris) {
      const one = await requeueOne({
        uri,
        store,
        fetchPost: (u) => nexus.post(u),
        botPk: cfg.botPk,
        replace: opts?.replace,
        replyOverride: opts?.replyUri,
      });
      lines.push(one.line);
      if (!one.ok) ok = false;
    }
    return { lines, ok };
  } finally {
    await store.close();
  }
}
