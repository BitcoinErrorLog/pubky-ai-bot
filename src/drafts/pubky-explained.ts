import type { Config } from "../config.js";
import type { Nexus } from "../nexus.js";
import { composeDraftProse, type DraftCompleteFn } from "./compose.js";
import { DraftRejectedError, finishDraft, isToolError, sanitizeUntrustedDraftText } from "./finish.js";
import { filterEvidenceUris, isAllowedEvidenceUri } from "./evidence-uri.js";
import { asPosts, postLink } from "./scout-util.js";
import type { ScoutTools } from "./scout-util.js";
import type { Draft } from "./types.js";
import { draftWindow, filterWindowPosts, DEFAULT_WINDOW_DAYS, type TimeWindow } from "./window.js";

export interface KnowledgeHit {
  content: string;
  source_url: string | null;
  product?: string;
  status?: string;
}

const QUESTION_TAGS = ["ask-pubky", "pubky-questions"] as const;
const QUESTIONISH = /\?|(?:\b(?:what|how|why|when|where|who|is|are|does|can|should)\b.+\b(?:pubky|homeserver|pkarr|pkdns|nexus|scout|ring)\b)/i;

export interface ExplainedQuestion {
  uri: string;
  author_id?: string;
  content: string;
}

export async function generatePubkyExplained(opts: {
  searchKnowledge: (query: string) => Promise<{ chunks: KnowledgeHit[] }>;
  scout?: ScoutTools;
  nexus?: Nexus;
  appUrl?: string;
  cfg?: Config;
  complete?: DraftCompleteFn;
  windowDays?: number;
  nowMs?: number;
  botPk?: string;
  questions?: ExplainedQuestion[];
  query?: string;
}): Promise<Draft> {
  const window = draftWindow(opts.nowMs ?? Date.now(), opts.windowDays ?? DEFAULT_WINDOW_DAYS);
  const questions =
    opts.questions ?? (opts.scout ? await collectQuestions(opts.scout, window, opts.botPk, opts.nexus) : []);
  const picked = pickQuestion(questions, opts.query);
  if (!picked) throw new DraftRejectedError("pubky_explained", "none: no suitable question this week");

  const result = await opts.searchKnowledge(picked.content.slice(0, 240));
  const chunks = result.chunks.filter((c) => c.source_url && isAllowedEvidenceUri(c.source_url, opts.appUrl));
  if (chunks.length === 0) throw new DraftRejectedError("pubky_explained", "none: knowledge unavailable for that question");
  const uris = filterEvidenceUris(
    [...chunks.map((c) => c.source_url).filter((u): u is string => Boolean(u)), picked.uri],
    opts.appUrl,
  );
  const notes = [
    `Question: ${sanitizeUntrustedDraftText(picked.content).slice(0, 280)}`,
    picked.uri.startsWith("http") ? `Asked in: ${picked.uri}` : "",
    "",
    "Retrieved chunks (paraphrase; never paste):",
    ...chunks.slice(0, 6).map((c) => {
      const status = c.status ? ` [${sanitizeUntrustedDraftText(c.status)}]` : "";
      return `- ${c.source_url}${status}\n  ${sanitizeUntrustedDraftText(c.content).slice(0, 280)}`;
    }),
  ]
    .filter((l) => l !== "")
    .join("\n");

  const body = await composeDraftProse({
    format: "pubky_explained",
    cfg: opts.cfg,
    complete: opts.complete,
    noneFallback: "could not answer from the index",
    evidenceNotes: notes,
    instruction: [
      "Answer the week's question in 3–6 short paragraphs, in Jeb's words — never a raw documentation paste.",
      "Status labels are inline clauses (canonical, planned, historical).",
      "End with a Sources: line listing only Evidence URLs. If you cannot answer from the chunks, reply none.",
    ].join(" "),
  });
  return finishDraft({
    format: "pubky_explained",
    title: "Pubky explained",
    body,
    uris,
    appUrl: opts.appUrl,
    tool_trace: [
      { tool: "search_knowledge", question: picked.content.slice(0, 120), hits: chunks.length, window },
    ],
  });
}

async function collectQuestions(
  scout: ScoutTools,
  window: TimeWindow,
  botPk?: string,
  nexus?: Nexus,
): Promise<ExplainedQuestion[]> {
  const time_range = { since: window.sinceMs, until: window.untilMs };
  const found: ExplainedQuestion[] = [];
  if (botPk) {
    const mentions = await scout.mentions_of.execute({ pubky: botPk, time_range, limit: 20 });
    if (!isToolError(mentions)) {
      for (const p of filterWindowPosts(asPosts(mentions), { window, botPk })) {
        let content = p.content ?? p.content_preview ?? "";
        if (!content && p.uri && nexus) {
          try {
            const view = await nexus.post(p.uri);
            content = view?.details.content ?? "";
          } catch {
            content = "";
          }
        }
        const q = asQuestion({ ...p, content }, "https://pubky.app");
        if (q) found.push(q);
      }
    }
  }
  for (const tag of QUESTION_TAGS) {
    const raw = await scout.search_posts.execute({ query: tag, tags: [tag], limit: 12, time_range });
    if (isToolError(raw)) continue;
    for (const p of filterWindowPosts(asPosts(raw), { window, botPk })) {
      const q = asQuestion(p, "https://pubky.app");
      if (q) found.push(q);
    }
  }
  const tagged = await scout.search_posts.execute({ query: "pubky", limit: 16, time_range });
  if (!isToolError(tagged)) {
    const ranked = filterWindowPosts(asPosts(tagged), { window, botPk })
      .filter((p) => QUESTIONISH.test(p.content_preview ?? p.content ?? ""))
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    for (const p of ranked.slice(0, 8)) {
      const q = asQuestion(p, "https://pubky.app");
      if (q) found.push(q);
    }
  }
  const seen = new Set<string>();
  return found.filter((q) => {
    if (seen.has(q.uri)) return false;
    seen.add(q.uri);
    return true;
  });
}

function asQuestion(
  p: { uri?: string; author_id?: string; post_id?: string; content?: string; content_preview?: string },
  appUrl: string,
): ExplainedQuestion | null {
  const content = (p.content ?? p.content_preview ?? "").trim();
  if (!content || !QUESTIONISH.test(content)) return null;
  const raw = p.uri ?? "";
  const uri = raw.startsWith("http") ? raw : postLink(raw, appUrl);
  if (!uri || !isAllowedEvidenceUri(uri, appUrl)) return null;
  return { uri, author_id: p.author_id, content };
}

function pickQuestion(questions: ExplainedQuestion[], override?: string): ExplainedQuestion | null {
  if (override?.trim()) {
    return questions[0]
      ? { ...questions[0], content: override.trim() }
      : { uri: "https://pubky.app", content: override.trim() };
  }
  return questions[0] ?? null;
}
