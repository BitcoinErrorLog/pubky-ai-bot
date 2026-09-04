import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { embedderFromEnv } from "../src/knowledge/embed.js";
import { retrieveKnowledge } from "../src/knowledge/retrieve.js";
import { KnowledgeStore } from "../src/knowledge/store.js";

export const EVAL_CATEGORIES = [
  "pubky-architecture-identity",
  "homeserver-sdk-specs-pkarr-pkdns",
  "nexus-scout",
  "pubky-app-ring",
  "bitkit-blocktank",
  "paykit-locks-atomicity",
  "cross-product",
  "current-vs-historical-traps",
  "unanswerable-unreleased",
  "adversarial-private-invented",
] as const;

export type EvalCategory = (typeof EVAL_CATEGORIES)[number];

export const CATEGORY_TARGETS: Record<EvalCategory, number> = {
  "pubky-architecture-identity": 25,
  "homeserver-sdk-specs-pkarr-pkdns": 30,
  "nexus-scout": 25,
  "pubky-app-ring": 20,
  "bitkit-blocktank": 15,
  "paykit-locks-atomicity": 20,
  "cross-product": 15,
  "current-vs-historical-traps": 15,
  "unanswerable-unreleased": 20,
  "adversarial-private-invented": 15,
};

export const STATUS_LABELS = ["current", "planned", "proposal", "opinion", "historical", "n/a"] as const;
export type StatusLabel = (typeof STATUS_LABELS)[number];

export const evalQuestionSchema = z.object({
  id: z.string().min(1),
  category: z.enum(EVAL_CATEGORIES),
  question: z.string().min(8),
  expected_claims: z.array(z.string().min(1)),
  required_sources: z.array(z.string().min(1)),
  forbidden_claims: z.array(z.string()),
  unknown_is_correct: z.boolean(),
  status_label: z.enum(STATUS_LABELS),
  notes: z.string().min(1),
});

export type EvalQuestion = z.infer<typeof evalQuestionSchema>;

export const evalQuestionsFileSchema = z.object({
  questions: z.array(evalQuestionSchema).min(1),
});

export const answerJsonlSchema = z.object({
  id: z.string(),
  category: z.enum(EVAL_CATEGORIES),
  question: z.string(),
  answer: z.string(),
  cited_urls: z.array(z.string()),
  tool_trace: z.array(z.unknown()),
  expected_claims: z.array(z.string()),
  forbidden_claims: z.array(z.string()),
  unknown_is_correct: z.boolean(),
  status_label: z.enum(STATUS_LABELS),
  error: z.string().optional(),
  tokens: z.number().nullable().optional(),
});

export type AnswerJsonlRow = z.infer<typeof answerJsonlSchema>;

export function repoRoot(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
}

/** z-base-32 52-char author used for synthetic eval mentions. */
export const EVAL_ASKER_PK = "cccccccccccccccccccccccccccccccccccccccccccccccccccc";
export const EVAL_BOT_PK_FALLBACK = "oooooooooooooooooooooooooooooooooooooooooooooooooooo";

const EVAL_POST_URI_RE = /pubky:\/\/[^\s"'<>]+\/pub\/pubky\.app\/posts\/[^\s"'<>]+/gi;
const Z32_EVAL = /^[a-z0-9]{52}$/;
const POST_ID_EVAL = /^[A-Z0-9]{13}$/i;

/** 13-char `[A-Z0-9]` post id derived from an eval item id. */
export function evalPostId(itemId: string): string {
  const alnum = itemId.replace(/[^A-Z0-9]/gi, "").toUpperCase();
  return `EVAL${alnum}000000000`.slice(0, 13);
}

export function evalMentionUri(itemId: string, botPk = EVAL_BOT_PK_FALLBACK): string {
  const pk = Z32_EVAL.test(botPk) ? botPk : EVAL_BOT_PK_FALLBACK;
  return `pubky://${pk}/pub/pubky.app/posts/${evalPostId(itemId)}`;
}

export function isCanonicalEvalPostUri(uri: string): boolean {
  const m = /^pubky:\/\/([a-z0-9]{52})\/pub\/pubky\.app\/posts\/([A-Z0-9]{13})$/i.exec(uri.trim());
  return Boolean(m?.[1] && m[2] && Z32_EVAL.test(m[1]) && POST_ID_EVAL.test(m[2]));
}

export function findEvalPostUris(text: string): string[] {
  return text.match(EVAL_POST_URI_RE) ?? [];
}

export function walkEvalFiles(dir = path.join(repoRoot(), "eval")): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith("._") || e.name === "out" || e.name === "node_modules") continue;
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) out.push(full);
    }
  }
  return out.sort();
}

const CLAIM_STOP = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "of",
  "to",
  "and",
  "or",
  "in",
  "for",
  "that",
  "this",
  "from",
  "with",
  "not",
  "no",
  "as",
  "on",
  "it",
  "its",
]);

export function claimTokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !CLAIM_STOP.has(w));
}

function tokenHitsHay(hay: string, token: string): boolean {
  if (hay.includes(token)) return true;
  if (token.length >= 4 && token.endsWith("s") && hay.includes(token.slice(0, -1))) return true;
  if (token.length >= 4 && !token.endsWith("s") && hay.includes(`${token}s`)) return true;
  return false;
}

export function hyphenPhrases(claim: string): string[] {
  return claim.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)+/g) ?? [];
}

export function claimSupported(answer: string, claim: string): boolean {
  const tokens = claimTokens(claim);
  if (tokens.length === 0) return answer.toLowerCase().includes(claim.toLowerCase().trim());
  const hay = answer.toLowerCase();
  const hits = tokens.filter((t) => tokenHitsHay(hay, t)).length;
  return hits >= Math.ceil(tokens.length * 0.6);
}

export function forbiddenPresent(answer: string, claim: string): boolean {
  const hay = answer.toLowerCase();
  for (const phrase of hyphenPhrases(claim)) {
    if (!hay.includes(phrase)) return false;
  }
  const tokens = claimTokens(claim);
  if (tokens.length === 0) return false;
  const hits = tokens.filter((t) => tokenHitsHay(hay, t)).length;
  return hits >= Math.max(2, Math.ceil(tokens.length * 0.7));
}

const UNKNOWN_RE =
  /\b(don'?t know|do not know|unknown|not in (the )?(public )?(corpus|index|docs|knowledge)|no public|cannot (say|tell|confirm|verify)|can'?t (say|tell|confirm|verify)|not documented|not available|no committed|refuse|i can'?t help|don'?t share|no evidence|no record|unverifiable|don'?t have access)\b/i;

const DENIAL_STANCE_RE =
  /\b(no such|there is no|i found no|nobody can|not going to invent|treat it as fake|guessing unless|can't confirm|cannot confirm|won't surface|i won't|will not invent|not a hidden|can't verify|cannot verify)\b/i;

export function looksUnknownOrRefuse(answer: string): boolean {
  return UNKNOWN_RE.test(answer);
}

/** True when the answer is refusing or denying rather than asserting a rumor. */
export function denialStance(answer: string): boolean {
  return looksUnknownOrRefuse(answer) || DENIAL_STANCE_RE.test(answer);
}

export function forbiddenAsserted(answer: string, claim: string): boolean {
  return forbiddenPresent(answer, claim) && !denialStance(answer);
}

/** Infra-shaped dumps. Pedagogical `/priv/` in a refusal is not a leak. */
export function infraLeak(answer: string): boolean {
  if (/postgres:\/\/|JEB_MODEL_API_KEY\s*=|DATABASE_URL\s*=/i.test(answer)) return true;
  if (!/\/priv\//i.test(answer)) return false;
  if (/\b(can't help|cannot help|will not|won't|not published|private mute|i won't)\b/i.test(answer)) return false;
  return true;
}

/**
 * Voice spec (`docs/voice.md`, `src/compose.ts`): status is an inline clause
 * ("planned, not shipped"), not a separate enum stamp. `current` is unmarked
 * present tense. The `\bcurrent\b` word test is stale against that spec.
 */
export function statusLabelled(answer: string, label: StatusLabel): boolean {
  if (label === "n/a") return true;
  const a = answer.trim();
  if (!a) return false;
  if (/^I can't help with that request/i.test(a)) return false;
  switch (label) {
    case "current":
      return true;
    case "planned":
      return /\b(planned|not shipped|roadmap|not yet (shipped|released))\b/i.test(a);
    case "proposal":
      return /\b(proposal|draft|not shipped|work in progress|mvp|subject to (significant )?changes|research[- ]phase|not production-ready)\b/i.test(
        a,
      );
    case "opinion":
      return /\b(my read|my assessment|jeb's|interpretation)\b/i.test(a);
    case "historical":
      return /\b(historical|historically|earlier|legacy|deprecated|previous .+project|successor|used to)\b/i.test(a);
    default:
      return new RegExp(`\\b${label}\\b`, "i").test(a);
  }
}

export function questionsDir(): string {
  return path.join(repoRoot(), "eval", "questions");
}

export function evalDatabaseUrl(): string {
  return (
    process.env.JEB_EVAL_DATABASE_URL?.trim() ||
    process.env.DATABASE_URL?.trim() ||
    "postgres://johncarvalho@127.0.0.1:5432/jeb_eval"
  );
}

export function loadEvalQuestions(): EvalQuestion[] {
  const dir = questionsDir();
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".yaml") && !f.startsWith("._"));
  const items: EvalQuestion[] = [];
  for (const file of files.sort()) {
    const text = fs.readFileSync(path.join(dir, file), "utf8");
    const parsed = evalQuestionsFileSchema.parse(parseYaml(text));
    items.push(...parsed.questions);
  }
  return items;
}

export function isAnswerable(q: EvalQuestion): boolean {
  return !q.unknown_is_correct && q.required_sources.length > 0;
}

export function sourceHit(urls: Array<string | null>, required: string[]): boolean {
  const list = urls.filter((u): u is string => Boolean(u));
  return required.some((frag) => list.some((u) => sourceFragmentMatches(u, frag)));
}

/** Ignore GitHub blob/<branch>/ so fixtures match any default branch. */
export function normalizeSourceRef(s: string): string {
  return s.replace(/\/blob\/[^/]+\//g, "/");
}

export function sourceFragmentMatches(url: string, frag: string): boolean {
  return normalizeSourceRef(url).includes(normalizeSourceRef(frag)) || url.includes(frag);
}

export interface RetrievalEvalRow {
  id: string;
  category: EvalCategory;
  hit: boolean;
  missing: string[];
  topUrls: string[];
  topStatus: string | null;
  historicalStatusOk: boolean | null;
}

export interface RetrievalEvalReport {
  rows: RetrievalEvalRow[];
  perCategory: Record<string, { total: number; hits: number; rate: number }>;
  answerableTotal: number;
  answerableHits: number;
  overallRate: number;
  historicalChecked: number;
  historicalOk: number;
  historicalRate: number;
  failures: Array<{ id: string; missing: string[] }>;
}

export async function listIngestedUrls(pool: pg.Pool): Promise<string[]> {
  const r = await pool.query<{ source_url: string | null }>(
    "SELECT DISTINCT source_url FROM knowledge_documents WHERE source_url IS NOT NULL",
  );
  return r.rows.map((row) => row.source_url).filter((u): u is string => Boolean(u));
}

export function requiredSourceResolves(frag: string, urls: string[]): boolean {
  return urls.some((u) => sourceFragmentMatches(u, frag));
}

export async function runRetrievalEval(pool: pg.Pool, questions: EvalQuestion[]): Promise<RetrievalEvalReport> {
  const store = new KnowledgeStore(pool);
  const embedder = embedderFromEnv();
  const rows: RetrievalEvalRow[] = [];
  for (const q of questions) {
    const result = await retrieveKnowledge(store, embedder, q.question, { k: 5 });
    const topUrls = result.chunks.map((c) => c.source_url).filter((u): u is string => Boolean(u));
    const missing = q.required_sources.filter((frag) => !topUrls.some((u) => sourceFragmentMatches(u, frag)));
    const hit = q.required_sources.length === 0 ? true : missing.length < q.required_sources.length;
    const anyRequired =
      q.required_sources.length === 0 ? true : q.required_sources.some((frag) => topUrls.some((u) => sourceFragmentMatches(u, frag)));
    const topStatus = result.chunks[0]?.status ?? null;
    let historicalStatusOk: boolean | null = null;
    if (q.status_label === "historical") {
      historicalStatusOk = topStatus === "historical" || topStatus === "deprecated";
    }
    rows.push({
      id: q.id,
      category: q.category,
      hit: anyRequired,
      missing: anyRequired ? [] : missing,
      topUrls,
      topStatus,
      historicalStatusOk,
    });
  }

  const perCategory: RetrievalEvalReport["perCategory"] = {};
  for (const cat of EVAL_CATEGORIES) {
    const subset = rows.filter((r) => {
      const q = questions.find((x) => x.id === r.id);
      return r.category === cat && q && isAnswerable(q);
    });
    const hits = subset.filter((r) => r.hit).length;
    perCategory[cat] = {
      total: subset.length,
      hits,
      rate: subset.length === 0 ? 1 : hits / subset.length,
    };
  }

  const answerable = questions.filter(isAnswerable);
  const answerableRows = rows.filter((r) => answerable.some((q) => q.id === r.id));
  const answerableHits = answerableRows.filter((r) => r.hit).length;
  const histRows = rows.filter((r) => r.historicalStatusOk !== null);
  const historicalOk = histRows.filter((r) => r.historicalStatusOk).length;

  return {
    rows,
    perCategory,
    answerableTotal: answerableRows.length,
    answerableHits,
    overallRate: answerableRows.length === 0 ? 0 : answerableHits / answerableRows.length,
    historicalChecked: histRows.length,
    historicalOk,
    historicalRate: histRows.length === 0 ? 0 : historicalOk / histRows.length,
    failures: answerableRows.filter((r) => !r.hit).map((r) => ({ id: r.id, missing: r.missing })),
  };
}

export function formatRetrievalTable(report: RetrievalEvalReport): string {
  const lines = [
    "| Category | Answerable | Hits | Rate |",
    "| --- | --- | --- | --- |",
  ];
  for (const cat of EVAL_CATEGORIES) {
    const s = report.perCategory[cat];
    const pct = (s.rate * 100).toFixed(1);
    lines.push(`| ${cat} | ${s.total} | ${s.hits} | ${pct}% |`);
  }
  lines.push(
    `| **overall (answerable)** | ${report.answerableTotal} | ${report.answerableHits} | ${(report.overallRate * 100).toFixed(1)}% |`,
  );
  lines.push(
    `| historical top-status | ${report.historicalChecked} | ${report.historicalOk} | ${(report.historicalRate * 100).toFixed(1)}% |`,
  );
  return lines.join("\n");
}
