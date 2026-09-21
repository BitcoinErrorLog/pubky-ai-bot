import type { Config } from "./config.js";
import type { Store } from "./db.js";
import type { Nexus } from "./nexus.js";
import type { PostView } from "./types.js";
import { completeReply } from "./model.js";
import {
  filterOpenTags,
  interactionArtifactApprover,
  proposeOpenTags,
} from "./bot-kit/tags/index.js";
import { applyTags, deriveCategories } from "./reply-tags.js";
import { SCOUT_TOOLS } from "./intent.js";
import { envSwitchOn } from "./switches.js";
import { log } from "./log.js";

const REPLY_ONLY = new Set(["answer", "declined", "summary"]);
export const MAX_INTERACTION_TARGETS = 4;

function canonicalPostUri(author: string, postId: string): string {
  return `pubky://${author}/pub/pubky.app/posts/${postId.toUpperCase()}`;
}

export function explicitInteractionUrisFromAnswer(answerContent: string): string[] {
  const cited = new Set<string>();
  for (const match of answerContent.matchAll(
    /pubky:\/\/([a-z0-9]{52})\/pub\/pubky\.app\/posts\/([A-Z0-9]{13})/gi,
  )) {
    cited.add(canonicalPostUri(match[1]!, match[2]!));
  }
  for (const match of answerContent.matchAll(
    /https?:\/\/[^\s)]+\/post\/([a-z0-9]{52})\/([A-Z0-9]{13})/gi,
  )) {
    cited.add(canonicalPostUri(match[1]!, match[2]!));
  }
  return [...cited];
}

export function interactionTargetUris(opts: {
  mention: PostView;
  explicitAnswerUris?: readonly string[];
}): string[] {
  const out: string[] = [];
  const add = (uri: string | null | undefined) => {
    if (!uri || out.includes(uri) || out.length >= MAX_INTERACTION_TARGETS) return;
    if (!/^pubky:\/\/[a-z0-9]{52}\/pub\/pubky\.app\/posts\/[A-Z0-9]{13}$/.test(uri)) return;
    out.push(uri);
  };

  add(opts.mention.details.uri);
  add(opts.mention.relationships?.reposted);

  const parentUri = opts.mention.relationships?.replied;
  const hasOwnAttachments = (opts.mention.details.attachments?.length ?? 0) > 0;
  const explicitlyNamesParent =
    /\b(?:parent|original|above)\s+(?:post|reply|photo|image|picture)\b/i.test(opts.mention.details.content);
  const refersToParentObject =
    !hasOwnAttachments &&
    (/\b(?:this|that|the)\s+(?:post|reply|quote|photo|image|picture)\b/i.test(opts.mention.details.content) ||
      /\b(?:translate|summarize|explain|describe)\s+(?:this|that|it|the\s+(?:post|reply|quote))\b/i.test(
        opts.mention.details.content,
      ));
  if (parentUri && (explicitlyNamesParent || refersToParentObject)) add(parentUri);

  for (const uri of opts.explicitAnswerUris ?? []) add(uri);

  return out;
}

export async function nexusTagCandidates(nexus: Nexus, seeds: readonly string[]): Promise<string[]> {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (labels: string[]) => {
    for (const l of labels) {
      if (seen.has(l)) continue;
      seen.add(l);
      out.push(l);
    }
  };
  try {
    add(await nexus.hotTags(40));
  } catch {
    /* prefer existing is best-effort */
  }
  for (const seed of seeds.slice(0, 5)) {
    const prefix = seed.slice(0, 12);
    if (prefix.length < 2) continue;
    try {
      add(await nexus.searchTags(prefix, 15));
    } catch {
      /* ignore */
    }
  }
  return out;
}

export async function modelProposeTags(
  cfg: Config,
  opts: { intent: string; postContent: string; content: string },
): Promise<string[]> {
  if (cfg.cannedReply !== undefined && cfg.cannedReply !== "") return [];
  if (!cfg.modelApiKey) return [];
  if (process.env.VITEST) return [];
  const prompt = tagProposalPrompt(opts);
  try {
    const out = await completeReply(cfg, prompt);
    return out.text
      .split(/[\s,]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  } catch (e) {
    log.warn({ err: String(e) }, "model tag propose failed; using fallback");
    return [];
  }
}

export function tagProposalPrompt(opts: {
  intent: string;
  postContent: string;
  content: string;
}): string {
  return [
    "Propose up to 5 search tags for this Pubky reply.",
    "Rules: lowercase, [a-z0-9-], at most 3 hyphenated words, at most 20 characters.",
    "Never use a person's name, handle, or pubky id. Never use slurs.",
    "Prefer existing community tags when they mean the same thing.",
    "Use only the interacted post and Jeb's answer below. Do not infer tags from other thread posts or evidence.",
    "Reply with a comma-separated list of tags only.",
    `Intent: ${opts.intent}`,
    `Interacted post: ${opts.postContent.slice(0, 600)}`,
    `Jeb answer: ${opts.content.slice(0, 800)}`,
  ].join("\n");
}

export function deriveScopedReplyTags(opts: {
  intent: string;
  proposed: string[];
  nexusTags: string[];
  personTokens?: string[];
}): string[] {
  return proposeOpenTags({
    intent: opts.intent,
    toolTrace: [],
    products: [],
    proposed: opts.proposed,
    nexusTags: opts.nexusTags,
    personTokens: opts.personTokens,
    graphTools: SCOUT_TOOLS,
  });
}

export async function composeReplyTags(opts: {
  cfg: Config;
  nexus: Nexus;
  intent: string;
  postContent: string;
  content: string;
  personTokens?: string[];
}): Promise<string[]> {
  const fallback = deriveCategories({ intent: opts.intent });
  const [proposed, nexusTags] = await Promise.all([
    modelProposeTags(opts.cfg, {
      intent: opts.intent,
      postContent: opts.postContent,
      content: opts.content,
    }),
    nexusTagCandidates(opts.nexus, [...fallback, opts.intent]),
  ]);
  const open = deriveScopedReplyTags({
    intent: opts.intent,
    proposed,
    nexusTags,
    personTokens: opts.personTokens,
  });
  return open.length > 0 ? open : fallback;
}

/** Artifact tags on the post Jeb just answered. Auto-approver sentinel; publisher re-checks botRepliedTo. */
export async function enqueueAnsweredArtifactTags(
  store: Store,
  opts: {
    targetUri: string;
    sourceMentionUri: string;
    labels: string[];
    personTokens?: string[];
  },
): Promise<void> {
  const labels = filterOpenTags(
    opts.labels.filter((l) => !REPLY_ONLY.has(l)),
    { personTokens: opts.personTokens },
  );
  if (labels.length === 0) return;
  await applyTags(
    {
      targetUri: opts.targetUri,
      labels,
      mode: "artifact",
      approvedBy: interactionArtifactApprover(opts.sourceMentionUri),
      personTokens: opts.personTokens,
    },
    { store, envSwitchOn },
  );
}
