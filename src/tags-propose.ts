import type { Config } from "./config.js";
import type { Store } from "./db.js";
import type { Nexus } from "./nexus.js";
import { completeReply } from "./model.js";
import {
  AUTO_ARTIFACT_APPROVER,
  filterOpenTags,
  proposeOpenTags,
} from "./bot-kit/tags/index.js";
import { applyTags, deriveCategories, productCategory } from "./reply-tags.js";
import { SCOUT_TOOLS } from "./intent.js";
import { envSwitchOn } from "./switches.js";
import { log } from "./log.js";

const REPLY_ONLY = new Set(["answer", "declined", "summary"]);

function slugProduct(product: string): string | null {
  const slug = product
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || null;
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
  opts: { intent: string; content: string; products: string[] },
): Promise<string[]> {
  if (cfg.cannedReply !== undefined && cfg.cannedReply !== "") return [];
  if (!cfg.modelApiKey) return [];
  if (process.env.VITEST) return [];
  const prompt = [
    "Propose up to 5 search tags for this Pubky reply.",
    "Rules: lowercase, [a-z0-9-], at most 3 hyphenated words, at most 20 characters.",
    "Never use a person's name, handle, or pubky id. Never use slurs.",
    "Prefer existing community tags when they mean the same thing.",
    "Reply with a comma-separated list of tags only.",
    `Intent: ${opts.intent}`,
    `Products: ${opts.products.join(", ") || "none"}`,
    `Reply: ${opts.content.slice(0, 800)}`,
  ].join("\n");
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

export async function composeReplyTags(opts: {
  cfg: Config;
  nexus: Nexus;
  intent: string;
  toolTrace: unknown[];
  products: string[];
  content: string;
  personTokens?: string[];
}): Promise<string[]> {
  const mapped = opts.products.map((p) => productCategory(p)).filter((x): x is string => x !== null);
  const slugs = opts.products.map((p) => slugProduct(p)).filter((x): x is string => x !== null);
  const products = [...new Set([...mapped, ...slugs])];
  const fallback = deriveCategories({
    intent: opts.intent,
    toolTrace: opts.toolTrace,
    products: opts.products,
  });
  const [proposed, nexusTags] = await Promise.all([
    modelProposeTags(opts.cfg, { intent: opts.intent, content: opts.content, products }),
    nexusTagCandidates(opts.nexus, [...products, ...fallback, opts.intent]),
  ]);
  const open = proposeOpenTags({
    intent: opts.intent,
    toolTrace: opts.toolTrace,
    products,
    proposed,
    nexusTags,
    personTokens: opts.personTokens,
    graphTools: SCOUT_TOOLS,
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
