import type { PostView, UserDetails } from "../types.js";

export const PER_POST_CHARS = 600;
export const TOTAL_CONTEXT_CHARS = 4_000;
export const MAX_CHAIN_POSTS = 8;

export interface ChainPost {
  uri: string;
  createdAt: number;
  author: string;
  name: string;
  content: string;
}

/** Jeb-specific thread labels and intro line; Kit does not bake a bot name. */
export interface ThreadPromptIdentity {
  assistantRoleLabel: string;
  introLine: (botPk: string) => string;
}

export interface ChainScreenDetector {
  detect(content: string): { detected: boolean; sanitized: string };
}

export interface SecretRedactResult {
  hits: unknown[];
  text: string;
}

export function ancestorsNewestFirst(chain: ChainPost[]): ChainPost[] {
  return [...chain].sort((a, b) => b.createdAt - a.createdAt);
}

export function clipContent(text: string, max = PER_POST_CHARS): string {
  return text.length <= max ? text : text.slice(0, max);
}

/**
 * Screens one chain post exactly like a tool-result string field
 * (src/tool-screen.ts): injection patterns are sanitized and secret-shaped
 * spans are redacted BEFORE the text reaches the model. Chain posts are
 * untrusted data on the same footing as tool output — the extraction guard
 * only inspects the mention, so this is the deterministic layer for
 * indirect injection via ancestor posts.
 */
export function screenChainContent(
  detector: ChainScreenDetector,
  content: string,
  redactSecrets: (s: string) => SecretRedactResult,
): string {
  const d = detector.detect(content);
  let s = d.detected ? d.sanitized : content;
  const redacted = redactSecrets(s);
  if (redacted.hits.length) s = redacted.text;
  return s;
}

export function assemblePrompt(
  botPk: string,
  mention: ChainPost,
  chain: ChainPost[],
  identity: ThreadPromptIdentity,
  detector: ChainScreenDetector,
  redactSecrets: (s: string) => SecretRedactResult,
): string {
  const ordered = ancestorsNewestFirst(chain).slice(0, MAX_CHAIN_POSTS);
  const lines: string[] = [];
  let used = 0;
  for (const p of ordered) {
    let content = clipContent(screenChainContent(detector, p.content, redactSecrets));
    if (used + content.length > TOTAL_CONTEXT_CHARS) {
      content = content.slice(0, Math.max(0, TOTAL_CONTEXT_CHARS - used));
    }
    used += content.length;
    const role = p.author === botPk ? identity.assistantRoleLabel : `user ${clipContent(p.name, 64)}`;
    lines.push(`[${p.createdAt}] ${role} (${p.author}): ${content}`);
    if (used >= TOTAL_CONTEXT_CHARS) break;
  }
  return [
    identity.introLine(botPk),
    "Thread (newest first):",
    ...lines,
    `Mention URI: ${mention.uri}`,
  ].join("\n");
}

export function asChainPost(view: PostView, user?: UserDetails | null): ChainPost {
  return {
    uri: view.details.uri,
    createdAt: view.details.indexed_at,
    author: view.details.author,
    name: user?.name || view.details.author.slice(0, 8),
    content: clipContent(view.details.content),
  };
}
