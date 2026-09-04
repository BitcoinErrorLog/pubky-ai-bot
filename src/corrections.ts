import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type pg from "pg";
import { stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { parsePostUri } from "./types.js";

/** Same categories as `scripts/eval-lib.ts` evalQuestionSchema. */
const EVAL_CATEGORIES = [
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

const evalQuestionSchema = z.object({
  id: z.string().min(1),
  category: z.enum(EVAL_CATEGORIES),
  question: z.string().min(8),
  expected_claims: z.array(z.string().min(1)),
  required_sources: z.array(z.string().min(1)),
  forbidden_claims: z.array(z.string()),
  unknown_is_correct: z.boolean(),
  status_label: z.enum(["current", "planned", "proposal", "opinion", "historical", "n/a"]),
  notes: z.string().min(1),
});

export type EvalQuestion = z.infer<typeof evalQuestionSchema>;

export interface CorrectionInsert {
  replyUri: string;
  reason: string;
  correctedBy: string;
  correctAnswer?: string;
}

export interface StoredCorrection {
  id: number;
  reply_uri: string;
  mention_key: string;
  reason: string;
  corrected_by: string;
  correct_answer: string | null;
  created_at: Date;
  exported_at: Date | null;
}

const CORRECTION_CATEGORY = "cross-product" satisfies (typeof EVAL_CATEGORIES)[number];

export function parseCorrectArgv(argv: string[]): {
  reply?: string;
  reason?: string;
  by?: string;
  correctAnswer?: string;
  exportEval?: string;
} {
  const out: {
    reply?: string;
    reason?: string;
    by?: string;
    correctAnswer?: string;
    exportEval?: string;
  } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    const take = (key: keyof typeof out) => {
      const v = argv[++i];
      if (!v || v.startsWith("-")) throw new Error(`missing value for ${a}`);
      out[key] = v;
    };
    if (a === "--reply") take("reply");
    else if (a.startsWith("--reply=")) out.reply = a.slice("--reply=".length);
    else if (a === "--reason") take("reason");
    else if (a.startsWith("--reason=")) out.reason = a.slice("--reason=".length);
    else if (a === "--by") take("by");
    else if (a.startsWith("--by=")) out.by = a.slice("--by=".length);
    else if (a === "--correct-answer") take("correctAnswer");
    else if (a.startsWith("--correct-answer=")) out.correctAnswer = a.slice("--correct-answer=".length);
    else if (a === "--export-eval") take("exportEval");
    else if (a.startsWith("--export-eval=")) out.exportEval = a.slice("--export-eval=".length);
  }
  return out;
}

export async function insertCorrection(
  pool: pg.Pool,
  botPk: string,
  input: CorrectionInsert,
): Promise<StoredCorrection> {
  let parsed;
  try {
    parsed = parsePostUri(input.replyUri);
  } catch {
    throw new Error("reply URI is not a canonical pubky post URI");
  }
  if (parsed.author !== botPk) {
    throw new Error("reply URI author is not JEB_BOT_PK");
  }
  const found = await pool.query<{ mention_key: string }>(
    `SELECT mention_key FROM handled_mentions WHERE reply_uri = $1 LIMIT 1`,
    [input.replyUri],
  );
  const mentionKey = found.rows[0]?.mention_key;
  if (!mentionKey) {
    throw new Error("reply URI is not in handled_mentions.reply_uri");
  }
  const reason = input.reason.trim();
  const by = input.correctedBy.trim();
  if (!reason) throw new Error("--reason is required");
  if (!by) throw new Error("--by is required");
  const correct = input.correctAnswer?.trim() || null;
  const r = await pool.query<{
    id: string;
    reply_uri: string;
    mention_key: string;
    reason: string;
    corrected_by: string;
    correct_answer: string | null;
    created_at: Date;
    exported_at: Date | null;
  }>(
    `INSERT INTO corrections (reply_uri, mention_key, reason, corrected_by, correct_answer)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, reply_uri, mention_key, reason, corrected_by, correct_answer, created_at, exported_at`,
    [input.replyUri, mentionKey, reason, by, correct],
  );
  const row = r.rows[0];
  if (!row) throw new Error("insert failed");
  return {
    id: Number(row.id),
    reply_uri: row.reply_uri,
    mention_key: row.mention_key,
    reason: row.reason,
    corrected_by: row.corrected_by,
    correct_answer: row.correct_answer,
    created_at: row.created_at,
    exported_at: row.exported_at,
  };
}

export function correctionToEvalQuestion(row: StoredCorrection, question: string): EvalQuestion {
  let body = question.trim();
  if (body.length < 8) body = `${body} mention ${row.mention_key}`.trim();
  if (body.length < 8) body = `${body}........`.slice(0, 8);
  const expected = row.correct_answer?.trim() ? [row.correct_answer.trim()] : [row.reason];
  const parsed = evalQuestionSchema.parse({
    id: `corr-${row.id}`,
    category: CORRECTION_CATEGORY,
    question: body,
    expected_claims: expected,
    required_sources: [],
    forbidden_claims: [],
    unknown_is_correct: !row.correct_answer,
    status_label: "current",
    notes: `Operator correction of ${row.reply_uri} by ${row.corrected_by}: ${row.reason}`,
  });
  return parsed;
}

export async function exportUnexportedCorrections(
  pool: pg.Pool,
  dir: string,
  fetchQuestion: (mentionKey: string) => Promise<string>,
): Promise<{ files: string[]; exportedIds: number[] }> {
  const pending = await pool.query<{
    id: string;
    reply_uri: string;
    mention_key: string;
    reason: string;
    corrected_by: string;
    correct_answer: string | null;
    created_at: Date;
    exported_at: Date | null;
  }>(
    `SELECT id, reply_uri, mention_key, reason, corrected_by, correct_answer, created_at, exported_at
     FROM corrections WHERE exported_at IS NULL ORDER BY id`,
  );
  mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  const exportedIds: number[] = [];
  for (const raw of pending.rows) {
    const row: StoredCorrection = {
      id: Number(raw.id),
      reply_uri: raw.reply_uri,
      mention_key: raw.mention_key,
      reason: raw.reason,
      corrected_by: raw.corrected_by,
      correct_answer: raw.correct_answer,
      created_at: raw.created_at,
      exported_at: raw.exported_at,
    };
    const question = await fetchQuestion(row.mention_key);
    const item = correctionToEvalQuestion(row, question);
    const filename = `corr-${row.id}.yaml`;
    const full = path.join(dir, filename);
    writeFileSync(
      full,
      stringifyYaml({ questions: [item] }, { lineWidth: 0 }),
      "utf8",
    );
    await pool.query(`UPDATE corrections SET exported_at = now() WHERE id = $1 AND exported_at IS NULL`, [row.id]);
    files.push(full);
    exportedIds.push(row.id);
  }
  return { files, exportedIds };
}
