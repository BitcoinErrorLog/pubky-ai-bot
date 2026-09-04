import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  EVAL_ASKER_PK,
  EVAL_BOT_PK_FALLBACK,
  evalMentionUri,
  evalPostId,
  findEvalPostUris,
  isCanonicalEvalPostUri,
  loadEvalQuestions,
  repoRoot,
  walkEvalFiles,
} from "../../scripts/eval-lib.js";
import { parsePostUri, POST_ID, Z32 } from "../../src/types.js";

describe("eval fixture canonical post URIs", () => {
  it("evalPostId is 13-char [A-Z0-9] for every question", () => {
    const questions = loadEvalQuestions();
    for (const q of questions) {
      expect(evalPostId(q.id)).toMatch(POST_ID);
      const uri = evalMentionUri(q.id, EVAL_BOT_PK_FALLBACK);
      expect(isCanonicalEvalPostUri(uri)).toBe(true);
      expect(parsePostUri(uri).postId).toHaveLength(13);
    }
    expect(Z32.test(EVAL_ASKER_PK)).toBe(true);
    expect(Z32.test(EVAL_BOT_PK_FALLBACK)).toBe(true);
  });

  it("fails if any eval file contains a non-canonical pubky:// post URI", () => {
    const bad: string[] = [];
    for (const file of walkEvalFiles()) {
      const text = fs.readFileSync(file, "utf8");
      for (const uri of findEvalPostUris(text)) {
        if (!isCanonicalEvalPostUri(uri)) {
          bad.push(`${path.relative(repoRoot(), file)}: ${uri}`);
        }
      }
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });
});
