import { PubkyAppPostKind, PubkySpecsBuilder } from "pubky-app-specs";

export type StandalonePostKind = "short" | "long";

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

function jsonRecord(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? Number(v) : v))) as Record<
    string,
    unknown
  >;
}

/**
 * Build and validate a standalone post via pubky-app-specs
 * (`PubkySpecsBuilder.createPost(content, kind, null, null, null)`).
 * Throws if spec validation rejects the object.
 */
export function buildStandalonePost(botPk: string, content: string, kind: StandalonePostKind): BuiltStandalonePost {
  const specs = new PubkySpecsBuilder(botPk);
  const specKind = kind === "long" ? PubkyAppPostKind.Long : PubkyAppPostKind.Short;
  const { post, meta } = specs.createPost(content, specKind, null, null, null);
  return {
    json: jsonRecord(post.toJson()),
    path: meta.path,
    url: meta.url,
    id: meta.id,
    content,
    kind,
  };
}
