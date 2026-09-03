import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CATEGORY_TARGETS,
  EVAL_CATEGORIES,
  answerJsonlSchema,
  evalQuestionSchema,
  loadEvalQuestions,
  repoRoot,
} from "../../scripts/eval-lib.js";

describe("eval question set", () => {
  const questions = loadEvalQuestions();

  it("loads at least 200 unique valid items", () => {
    expect(questions.length).toBeGreaterThanOrEqual(200);
    const ids = questions.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const q of questions) {
      expect(evalQuestionSchema.safeParse(q).success).toBe(true);
    }
  });

  it("matches target counts per category", () => {
    for (const cat of EVAL_CATEGORIES) {
      const n = questions.filter((q) => q.category === cat).length;
      expect(n, cat).toBe(CATEGORY_TARGETS[cat]);
    }
  });

  it("unanswerable and adversarial items allow unknown", () => {
    const unk = questions.filter((q) => q.category === "unanswerable-unreleased");
    const adv = questions.filter((q) => q.category === "adversarial-private-invented");
    expect(unk.every((q) => q.unknown_is_correct)).toBe(true);
    expect(adv.every((q) => q.unknown_is_correct)).toBe(true);
    expect(unk.every((q) => q.required_sources.length === 0)).toBe(true);
  });
});

describe("answer JSONL schema", () => {
  it("accepts a complete row and rejects missing answer", () => {
    const row = {
      id: "arch-001",
      category: "pubky-architecture-identity" as const,
      question: "What is Pubky?",
      answer: "Pubky uses public-key identity.",
      cited_urls: ["https://pubky.org/Architecture.md"],
      tool_trace: [{ toolCalls: [{ name: "search_knowledge", args: { query: "x" } }] }],
      expected_claims: ["Ed25519 key pairs"],
      forbidden_claims: [],
      unknown_is_correct: false,
      status_label: "current" as const,
    };
    expect(answerJsonlSchema.parse(row).id).toBe("arch-001");
    expect(answerJsonlSchema.safeParse({ ...row, answer: undefined }).success).toBe(false);
  });

  it("eval:answers exits non-zero when JEB_MODEL_API_KEY is missing", () => {
    const env = { ...process.env };
    delete env.JEB_MODEL_API_KEY;
    const script = path.join(repoRoot(), "scripts", "eval-answers.ts");
    const r = spawnSync("npx", ["tsx", script], {
      cwd: repoRoot(),
      env,
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toContain("missing env: JEB_MODEL_API_KEY");
  });
});
