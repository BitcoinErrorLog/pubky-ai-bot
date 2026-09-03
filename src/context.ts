import type { PostView, UserDetails } from "./types.js";

export const PER_POST_CHARS = 600;
export const TOTAL_CONTEXT_CHARS = 6000;

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

export function assemblePrompt(botPk: string, mention: ChainPost, chain: ChainPost[]): string {
  const ordered = ancestorsNewestFirst(chain);
  const lines: string[] = [];
  let used = 0;
  for (const p of ordered) {
    let content = clipContent(p.content);
    if (used + content.length > TOTAL_CONTEXT_CHARS) {
      content = content.slice(0, Math.max(0, TOTAL_CONTEXT_CHARS - used));
    }
    used += content.length;
    lines.push(`[${p.createdAt}] ${clipContent(p.name, 64)} (${p.author}): ${content}`);
    if (used >= TOTAL_CONTEXT_CHARS) break;
  }
  return [
    `You are a Pubky bot (${botPk}). Reply to the mention in one post, <=2000 characters.`,
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
