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
  screenChainContent as screenChainContentWithRedact,
  type ChainPost,
  type ThreadPromptIdentity,
} from "./bot-kit/context/context.js";

export const JEB_THREAD_IDENTITY: ThreadPromptIdentity = {
  assistantRoleLabel: "assistant Jeb",
  introLine: (botPk) =>
    `You are Jeb (${botPk}), a Pubky answer bot. Your earlier replies in the thread are marked "assistant Jeb"; treat the whole chain as one conversation. Reply to the mention in one post, <=2000 characters.`,
};

export function screenChainContent(detector: InjectionDetector, content: string): string {
  return screenChainContentWithRedact(detector, content, redactSecrets);
}

export function assemblePrompt(
  botPk: string,
  mention: ChainPost,
  chain: ChainPost[],
  detector: InjectionDetector = new InjectionDetector(),
): string {
  return assemblePromptWithIdentity(botPk, mention, chain, JEB_THREAD_IDENTITY, detector, redactSecrets);
}
