import { LONG_LIMIT, QUOTA_ANSWER_LEADIN } from "./compose.js";
import { costBoundsFromDefaults } from "./cost-bounds.js";
import { DEFAULT_PROACTIVE_MAX_PER_DAY, DRAFT_FORMAT_LABELS, DRAFT_FORMATS, type DraftFormat } from "./drafts/types.js";
import { tokensToUsd } from "./metrics-db.js";
import {
  ARTIFACT_TAG_MEANINGS,
  ARTIFACT_TAG_VOCAB,
  MAX_REPLY_TAGS,
  REPLY_TAG_MEANINGS,
  REPLY_TAG_VOCABULARY,
} from "./reply-tags.js";
import { SKIP_NOTICE_TEXT } from "./skip-notice.js";
import { lintVoice } from "./voice.js";

export const HOW_I_WORK_TITLE = "How I work";
export const HOW_I_WORK_RELATIVE_PATH = "content/how-i-work.json";

export interface HowIWorkArticle {
  title: string;
  body: string;
}

function usdRange(tokens: number, priceIn: number, priceOut: number): string {
  const lo = tokensToUsd(tokens, 0, tokens, priceIn, priceOut);
  const hi = tokensToUsd(0, tokens, tokens, priceIn, priceOut);
  return `$${lo.toFixed(2)} at input list price / $${hi.toFixed(2)} at output list price`;
}

function tagLines(
  labels: readonly string[],
  meanings: Record<string, string>,
): string {
  return labels.map((label) => `- ${label}: ${meanings[label]}`).join("\n");
}

function formatList(formats: readonly DraftFormat[]): string {
  return formats.map((f) => DRAFT_FORMAT_LABELS[f]).join("; ");
}

/** Article JSON consumed by `scripts/post.ts --kind long`. Numbers and tags come from code. */
export function generateHowIWorkArticle(): HowIWorkArticle {
  const bounds = costBoundsFromDefaults();
  const dailyUsd = usdRange(bounds.dailyTokenBudget, bounds.priceIn, bounds.priceOut);
  const userUsd = usdRange(bounds.userDailyTokenBudget, bounds.priceIn, bounds.priceOut);
  const dailyTokens = bounds.dailyTokenBudget.toLocaleString("en-US");
  const userTokens = bounds.userDailyTokenBudget.toLocaleString("en-US");
  const body = [
    "I'm Jeb, an automated account operated by Synonym. I answer public questions about Pubky, the Synonym stack, the public social graph, and, when you ask, the wider web. Mention my key in a post, or reply to one of my posts to keep talking. I am not John and I do not speak for him.",
    "",
    "What I answer",
    "",
    "Technical questions about homeservers, PKARR, PKDNS, Ring, Nexus, Scout, the app specs, Bitkit, Paykit, and related public docs and code. Graph questions document search cannot: who tagged what as what, with claimant counts; what changed on a topic; where disagreements sit; how two people relate on the public graph. Thread summaries, translations of public posts, claim checks, and live web search when the question is off-network. If I do not have a public source I say so instead of inventing one.",
    "",
    "How evidence is shown",
    "",
    "Tags are claims by identifiable keys, not facts. I report claimant counts, not verdicts. When I interpret, I mark it as my read and show the numbers or links it rests on. Minority positions are listed, not dropped.",
    "",
    "When I count claims about a person or a topic I can show two numbers side by side, labelled: everyone on the network (global), and only the people within one or two follows of you (within-your-graph). Same evidence, two vantage points. Ask for the graph-local number when you want your neighbourhood's view.",
    "",
    "Cost bounds",
    "",
    `My daily ceiling is ${dailyTokens} tokens (${dailyUsd}; list prices $${bounds.priceIn}/1M input and $${bounds.priceOut}/1M output, Kimi K3 family). Per person the ceiling is ${userTokens} tokens (${userUsd}). Both reset at 00:00 UTC. Top-ups are not yet available.`,
    "",
    `When I hit a token ceiling I post a notice and stop answering until reset: "${SKIP_NOTICE_TEXT.budget}"`,
    "",
    `When an accepted mention is the last one a quota still permits, I prefix the reply with one sentence, then "${QUOTA_ANSWER_LEADIN}" on its own line. Prefixes never stack. The prefix is kept intact; the answer is trimmed to the post cap. The last-allowed sentences cover the daily token ceilings, the hourly reply cap, the per-thread turn cap, and the thread reply cap.`,
    "",
    "Opt-out",
    "",
    "Mention me with \"stop replying to me\" (also \"opt out\", \"unsubscribe\", \"mute me\", \"leave me alone\"). I confirm once and then skip your mentions silently until you mention me with \"you can reply to me again\". Nobody else can opt you out; I act on who wrote the post.",
    "",
    "Pause",
    "",
    "An operator can pause me. They can stop me reading the network, generating answers, publishing replies, using Scout, using web search, or halt everything at once. If I go quiet for everyone, that is usually why.",
    "",
    "Proactive posts",
    "",
    `I may compose these formats: ${formatList(DRAFT_FORMATS)}. None of them reach the network unless an operator approves the draft. Approved proactive posts are capped at ${DEFAULT_PROACTIVE_MAX_PER_DAY} per UTC day. There is no cron-to-network path.`,
    "",
    "Tags I may apply",
    "",
    `On my own replies I write at most ${MAX_REPLY_TAGS} category labels under my key. I never tag other people's posts this way.`,
    "",
    "Reply category self-tags:",
    tagLines(REPLY_TAG_VOCABULARY, REPLY_TAG_MEANINGS),
    "",
    "After operator review I may tag anyone's public post with this artifact vocabulary (also under my key; never autonomous):",
    tagLines(ARTIFACT_TAG_VOCAB, ARTIFACT_TAG_MEANINGS),
    "",
    "This vocabulary is small on purpose. An operator reviews it every week. Adding or removing a label is a code change; this article is then regenerated from that code so the published list cannot drift.",
    "",
    "Secrets",
    "",
    "I will never say, and mechanically cannot be made to publish, key material, credentials, tokens, or internal configuration; any request for those gets one declined reply.",
    "",
    "Where this lives",
    "",
    "The source repository is the Source code link on my profile. This article is the policy: the How I work link on my profile points here. Numbers and labels above are generated from the running code defaults, not typed by hand.",
  ].join("\n");

  if (body.length > LONG_LIMIT) {
    throw new Error(`How I work body exceeds long-post cap (${body.length} > ${LONG_LIMIT})`);
  }
  const { violations } = lintVoice(body, { citationCap: 8 });
  if (violations.length) {
    throw new Error(`How I work failed voice lint: ${violations.map((v) => `${v.rule}:${v.detail}`).join("; ")}`);
  }
  return { title: HOW_I_WORK_TITLE, body };
}

export function generateHowIWorkFileText(): string {
  const article = generateHowIWorkArticle();
  return `${JSON.stringify(article, null, 2)}\n`;
}
