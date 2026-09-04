import { PubkyAppPostKind, PubkySpecsBuilder } from "pubky-app-specs";
import { jsonRecord } from "./upload.js";

export type StandalonePostKind = "short" | "long";

export const MAX_POST_ATTACHMENTS = 10;

export interface BuiltStandalonePost {
  json: Record<string, unknown>;
  path: string;
  url: string;
  id: string;
  content: string;
  kind: StandalonePostKind;
}

/** Operator-facing gate: the standalone post writer obeys the same write-path
 * switches as replies, and never runs in contract mode. */
export function assertPostPublishAllowed(opts: { contractMode: boolean; repliesSwitchOn: boolean }): void {
  if (opts.contractMode) throw new Error("refusing to publish post: JEB_CONTRACT_MODE=1");
  if (opts.repliesSwitchOn) throw new Error("refusing to publish post: replies/global switch is on");
}

export function parseKind(raw: string | undefined): StandalonePostKind {
  const k = (raw ?? "short").trim().toLowerCase();
  if (k === "short" || k === "long") return k;
  throw new Error("--kind must be short or long");
}

/**
 * For `--kind long`, a file may be plain text or JSON `{title, body}`.
 * Operator long posts on the network store that JSON object as `content`.
 */
export function contentFromFile(raw: string, kind: StandalonePostKind): string {
  const text = raw.replace(/^\uFEFF/, "");
  if (kind !== "long") return text;
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return text;
  }
  if (
    parsed !== null &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    typeof (parsed as { title?: unknown }).title === "string" &&
    typeof (parsed as { body?: unknown }).body === "string"
  ) {
    const title = (parsed as { title: string }).title;
    const body = (parsed as { body: string }).body;
    return JSON.stringify({ title, body });
  }
  return text;
}

export function assertAttachmentCount(count: number): void {
  if (count > MAX_POST_ATTACHMENTS) {
    throw new Error(`--attach may be repeated at most ${MAX_POST_ATTACHMENTS} times (got ${count})`);
  }
}

/**
 * Build and validate a standalone post via pubky-app-specs
 * (`PubkySpecsBuilder.createPost(content, kind, null, null, attachments)`).
 * Throws if spec validation rejects the object.
 */
export function buildStandalonePost(
  botPk: string,
  content: string,
  kind: StandalonePostKind,
  attachments: string[] | null = null,
  editId?: string,
): BuiltStandalonePost {
  const list = attachments && attachments.length > 0 ? attachments : null;
  if (list) assertAttachmentCount(list.length);
  const specs = new PubkySpecsBuilder(botPk);
  const specKind = kind === "long" ? PubkyAppPostKind.Long : PubkyAppPostKind.Short;
  const { post, meta } = specs.createPost(content, specKind, null, null, list);
  if (editId === undefined) {
    return { json: jsonRecord(post.toJson()), path: meta.path, url: meta.url, id: meta.id, content, kind };
  }
  const id = parseEditId(editId);
  return {
    json: jsonRecord(post.toJson()),
    path: `/pub/pubky.app/posts/${id}`,
    url: `pubky://${botPk}/pub/pubky.app/posts/${id}`,
    id,
    content,
    kind,
  };
}

/** `--edit <id>`: overwrite an existing post under the bot key in place (same URI). */
export function parseEditId(raw: string): string {
  const id = raw.trim().toUpperCase();
  if (!/^[A-Z0-9]{13}$/.test(id)) throw new Error("--edit must be a 13-character post id");
  return id;
}

/** `--keep-attachment <uri>`: an existing file URI under the bot key to keep on an edited post. */
export function parseKeptAttachment(raw: string, botPk: string): string {
  const uri = raw.trim();
  const prefix = `pubky://${botPk}/pub/pubky.app/files/`;
  if (!uri.startsWith(prefix) || !/^[A-Z0-9]{13}$/.test(uri.slice(prefix.length))) {
    throw new Error("--keep-attachment must be a pubky://<bot>/pub/pubky.app/files/<id> URI under the bot key");
  }
  return uri;
}
