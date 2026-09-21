import type { Config } from "./config.js";
import type { Store } from "./db.js";
import type { Nexus } from "./nexus.js";
import { completeReply } from "./model.js";
import {
  AUTO_ARTIFACT_APPROVER,
  filterOpenTags,
  proposeOpenTags,
} from "./bot-kit/tags/index.js";
import { applyTags, deriveCategories } from "./reply-tags.js";
import { SCOUT_TOOLS } from "./intent.js";
import { envSwitchOn } from "./switches.js";
import { log } from "./log.js";

const REPLY_ONLY = new Set(["answer", "declined", "summary"]);

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
  opts: { intent: string; mentionContent: string; content: string },
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
  mentionContent: string;
  content: string;
}): string {
  return [
    "Propose up to 5 search tags for this Pubky reply.",
    "Rules: lowercase, [a-z0-9-], at most 3 hyphenated words, at most 20 characters.",
    "Never use a person's name, handle, or pubky id. Never use slurs.",
    "Prefer existing community tags when they mean the same thing.",
    "Use only the current mention and Jeb's answer below. Do not infer tags from earlier thread posts.",
    "Reply with a comma-separated list of tags only.",
    `Intent: ${opts.intent}`,
    `Current mention: ${opts.mentionContent.slice(0, 600)}`,
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
  mentionContent: string;
  content: string;
  personTokens?: string[];
}): Promise<string[]> {
  const fallback = deriveCategories({ intent: opts.intent });
  const [proposed, nexusTags] = await Promise.all([
    modelProposeTags(opts.cfg, {
      intent: opts.intent,
      mentionContent: opts.mentionContent,
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
  opts: { parentUri: string; labels: string[]; personTokens?: string[] },
): Promise<void> {
  const labels = filterOpenTags(
    opts.labels.filter((l) => !REPLY_ONLY.has(l)),
    { personTokens: opts.personTokens },
  );
  if (labels.length === 0) return;
  await applyTags(
    {
      targetUri: opts.parentUri,
      labels,
      mode: "artifact",
      approvedBy: AUTO_ARTIFACT_APPROVER,
      personTokens: opts.personTokens,
    },
    { store, envSwitchOn },
  );
}
