import type { PostView, UserDetails } from "./types.js";

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

export function assemblePrompt(botPk: string, mention: ChainPost, chain: ChainPost[]): string {
  const ordered = ancestorsNewestFirst(chain);
  const lines = ordered.map((p) => `[${p.createdAt}] ${p.name} (${p.author}): ${p.content}`);
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
    content: view.details.content,
  };
}
