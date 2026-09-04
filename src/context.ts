import { InjectionDetector } from "./injection-detector.js";
import { redactSecrets } from "./secret-scrub.js";
import type { PostView, UserDetails } from "./types.js";

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
export function screenChainContent(detector: InjectionDetector, content: string): string {
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
  detector: InjectionDetector = new InjectionDetector(),
): string {
  const ordered = ancestorsNewestFirst(chain).slice(0, MAX_CHAIN_POSTS);
  const lines: string[] = [];
  let used = 0;
  for (const p of ordered) {
    let content = clipContent(screenChainContent(detector, p.content));
    if (used + content.length > TOTAL_CONTEXT_CHARS) {
      content = content.slice(0, Math.max(0, TOTAL_CONTEXT_CHARS - used));
    }
    used += content.length;
    const role = p.author === botPk ? "assistant Jeb" : `user ${clipContent(p.name, 64)}`;
    lines.push(`[${p.createdAt}] ${role} (${p.author}): ${content}`);
    if (used >= TOTAL_CONTEXT_CHARS) break;
  }
  return [
    `You are Jeb (${botPk}), a Pubky answer bot. Your earlier replies in the thread are marked "assistant Jeb"; treat the whole chain as one conversation. Reply to the mention in one post, <=2000 characters.`,
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
