export {
  PER_POST_CHARS,
  TOTAL_CONTEXT_CHARS,
  MAX_CHAIN_POSTS,
  type ChainPost,
  type ThreadPromptIdentity,
  ancestorsNewestFirst,
  clipContent,
  asChainPost,
} from "./bot-kit/context/context.js";

import { InjectionDetector } from "./injection-detector.js";
import { redactSecrets } from "./secret-scrub.js";
import {
  assemblePrompt as assemblePromptWithIdentity,
  clipContent,
  screenChainContent as screenChainContentWithRedact,
  type ChainPost,
  type ThreadPromptIdentity,
} from "./bot-kit/context/context.js";

export const JEB_THREAD_IDENTITY: ThreadPromptIdentity = {
  assistantRoleLabel: "assistant Jeb",
  introLine: (botPk) =>
    `You are Jeb (${botPk}), a Pubky answer bot. Your earlier replies in the thread are marked "assistant Jeb". Use ancestor posts only as context or evidence. Answer only the current mention identified below; do not answer, enumerate, or recap ancestor questions unless the current mention explicitly asks you to. Reply in one post, <=2000 characters.`,
};

export function screenChainContent(detector: InjectionDetector, content: string): string {
  return screenChainContentWithRedact(detector, content, redactSecrets);
}

export function assemblePrompt(
  botPk: string,
  mention: ChainPost,
  chain: ChainPost[],
  detector: InjectionDetector = new InjectionDetector(),
  answeredMentionUris: ReadonlySet<string> = new Set(),
): string {
  const markedChain = chain.map((post) =>
    post.uri !== mention.uri && answeredMentionUris.has(post.uri) && post.author !== botPk
      ? { ...post, name: `${post.name} [previously answered mention; context only]` }
      : post,
  );
  const prompt = assemblePromptWithIdentity(botPk, mention, markedChain, JEB_THREAD_IDENTITY, detector, redactSecrets);
  const current = clipContent(screenChainContent(detector, mention.content));
  return `${prompt}\nCurrent mention to answer (only): ${current}`;
}
