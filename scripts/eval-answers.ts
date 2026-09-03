#!/usr/bin/env npx tsx
import fs from "node:fs";
import path from "node:path";
import { answerMention } from "../src/answer.js";
import { configFromProcessEnv } from "../src/config.js";
import type { ChainPost } from "../src/context.js";
import { Nexus } from "../src/nexus.js";
import {
  answerJsonlSchema,
  evalDatabaseUrl,
  loadEvalQuestions,
  repoRoot,
  type AnswerJsonlRow,
} from "./eval-lib.js";

const MISSING = "JEB_MODEL_API_KEY";

if (!process.env.JEB_MODEL_API_KEY?.trim()) {
  console.error(`missing env: ${MISSING}`);
  process.exit(1);
}

if (!process.env.DATABASE_URL?.trim()) {
  process.env.DATABASE_URL = evalDatabaseUrl();
}

const questions = loadEvalQuestions();
const cfg = configFromProcessEnv({ requireSecret: false, role: "reason" });
const nexus = new Nexus(cfg.nexusUrl, cfg.nexusTimeoutMs);
const botPk = cfg.botPk ?? "oooooooooooooooooooooooooooooooooooooooooooooooooooo";
const outDir = path.join(repoRoot(), "eval", "out");
fs.mkdirSync(outDir, { recursive: true });
const jsonlPath = path.join(outDir, "answers.jsonl");
const reviewPath = path.join(outDir, "review.md");
const lines: string[] = [];
const review: string[] = [
  "# Jeb knowledge answer review sheet",
  "",
  "Grade each answer against expected claims. Mark invented claims. Unanswerable items must stay unknown.",
  "",
];

for (const q of questions) {
  const mention: ChainPost = {
    uri: `pubky://${botPk}/pub/pubky.app/posts/eval${q.id.replace(/[^a-z0-9]/gi, "").slice(0, 8)}aaaa`,
    createdAt: Date.now(),
    author: "cccccccccccccccccccccccccccccccccccccccccccccccccccc",
    name: "eval-asker",
    content: q.question,
  };
  const result = await answerMention(cfg, nexus, botPk, mention, [mention]);
  const cited = [...result.sources];
  const row: AnswerJsonlRow = answerJsonlSchema.parse({
    id: q.id,
    category: q.category,
    question: q.question,
    answer: result.content ?? "",
    cited_urls: cited,
    tool_trace: result.toolTrace,
    expected_claims: q.expected_claims,
    forbidden_claims: q.forbidden_claims,
    unknown_is_correct: q.unknown_is_correct,
    status_label: q.status_label,
  });
  lines.push(JSON.stringify(row));
  review.push(`## ${q.id} (${q.category})`);
  review.push("");
  review.push(`**Question:** ${q.question}`);
  review.push("");
  review.push(`**Status label required:** ${q.status_label}`);
  review.push(`**Unknown is correct:** ${q.unknown_is_correct}`);
  review.push("");
  review.push("**Expected claims:**");
  for (const c of q.expected_claims) review.push(`- ${c}`);
  review.push("");
  review.push("**Forbidden claims:**");
  for (const c of q.forbidden_claims) review.push(`- ${c}`);
  if (q.forbidden_claims.length === 0) review.push("- (none)");
  review.push("");
  review.push("**Answer:**");
  review.push("");
  review.push(row.answer || "_(empty)_");
  review.push("");
  review.push(`**Cited URLs:** ${row.cited_urls.join(", ") || "(none)"}`);
  review.push("");
  review.push(`**Notes:** ${q.notes}`);
  review.push("");
}

fs.writeFileSync(jsonlPath, `${lines.join("\n")}\n`);
fs.writeFileSync(reviewPath, `${review.join("\n")}\n`);
console.log(`wrote ${questions.length} answers to ${jsonlPath}`);
console.log(`review sheet: ${reviewPath}`);
