import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { loadEvalQuestions, repoRoot } from "../../scripts/eval-lib.js";

const EXPERIMENTAL_RECOMMENDATION =
  /\b(?:sealed blob(?:\s+v2)?|sb2|appcert|ukd|molt[- ]drop|atomicity-(?:legacy|core)|keybinding|unlockgrant|appkey|pubky_crypto_spec|PUBKY_CRYPTO_SPEC|bitcoinerrorlog\/pubky-noise)\b/i;

function containsExperimentalRecommendationContent(value: {
  question: string;
  expected_claims: string[];
  notes: string;
}): boolean {
  return [
    value.question,
    ...value.expected_claims,
    value.notes,
  ].some((text) => EXPERIMENTAL_RECOMMENDATION.test(text));
}

describe("R2 content-only cleanup", () => {
  it("uses upstream pubky-noise master as the canonical production source", () => {
    const manifest = parseYaml(fs.readFileSync(`${repoRoot()}/sources.yaml`, "utf8")) as {
      sources: Array<Record<string, unknown>>;
    };
    const noise = manifest.sources.find((source) => source.id === "pubky-noise-docs");
    expect(noise).toMatchObject({
      location: "https://github.com/pubky/pubky-noise",
      ref: "master",
      cite_base: "https://github.com/pubky/pubky-noise/blob/master",
      status: "canonical",
    });
  });

  it("excludes the fork-specific Pubky Noise article from the knowledge-base manifest", () => {
    const manifest = parseYaml(fs.readFileSync(`${repoRoot()}/sources.yaml`, "utf8")) as {
      sources: Array<{ id: string; exclude?: string[] }>;
    };
    const knowledgeBase = manifest.sources.find((source) => source.id === "pubky-knowledge-base");
    expect(knowledgeBase?.exclude).toContain("Explore/Technologies/PubkyNoise.md");
  });

  it("excludes the evolving Sealed Blob implementation page only", () => {
    const manifest = parseYaml(fs.readFileSync(`${repoRoot()}/sources.yaml`, "utf8")) as {
      sources: Array<{ id: string; include?: string[]; exclude?: string[] }>;
    };
    const knowledgeBase = manifest.sources.find((source) => source.id === "pubky-knowledge-base");
    expect(knowledgeBase?.include).toContain("**/*.md");
    expect(knowledgeBase?.exclude).toContain("Explore/Technologies/Paykit.md");
    expect(knowledgeBase?.exclude).not.toContain("Explore/Technologies");
  });

  it("does not ingest the normative Pubky Locks README", () => {
    const manifest = parseYaml(fs.readFileSync(`${repoRoot()}/sources.yaml`, "utf8")) as {
      sources: Array<{ id: string; include?: string[]; exclude?: string[] }>;
    };
    const locks = manifest.sources.find((source) => source.id === "pubky-locks-docs");
    expect(locks).toBeUndefined();
  });

  it("contains no experimental crypto recommendation content in eval questions", () => {
    const questions = loadEvalQuestions();
    expect(questions.some(containsExperimentalRecommendationContent)).toBe(false);
  });

  it("contains no org-insensitive legacy fork README question", () => {
    const questions = loadEvalQuestions();
    expect(
      questions.some(({ question, expected_claims, notes }) =>
        [...[question], ...expected_claims, notes].some((text) =>
          /no shared git history|official pubky\/pubky-noise|pubky-noise.*README/i.test(text),
        ),
      ),
    ).toBe(false);
  });

  it("rejects a deliberately bad in-memory question fixture", () => {
    const badQuestion = {
      question: "What should production use for Sealed Blob v2?",
      expected_claims: ["Use SB2 in the production transport"],
      forbidden_claims: [],
      notes: "bad fixture",
    };
    expect(containsExperimentalRecommendationContent(badQuestion)).toBe(true);
  });
});
