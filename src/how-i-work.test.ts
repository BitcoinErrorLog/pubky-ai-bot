import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { LONG_LIMIT } from "./compose.js";
import {
  DEFAULT_DAILY_TOKEN_BUDGET,
  DEFAULT_MODEL_PRICE_PER_MTOK_IN,
  DEFAULT_MODEL_PRICE_PER_MTOK_OUT,
  DEFAULT_USER_DAILY_TOKEN_BUDGET,
} from "./config.js";
import { DEFAULT_PROACTIVE_MAX_PER_DAY } from "./drafts/types.js";
import {
  generateHowIWorkArticle,
  generateHowIWorkFileText,
  HOW_I_WORK_RELATIVE_PATH,
  HOW_I_WORK_TITLE,
} from "./how-i-work.js";
import { ARTIFACT_TAG_VOCAB, REPLY_TAG_VOCABULARY } from "./reply-tags.js";
import { SKIP_NOTICE_TEXT } from "./skip-notice.js";
import { lintVoice } from "./voice.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("How I work article", () => {
  it("lints clean and stays within the long-post cap", () => {
    const { title, body } = generateHowIWorkArticle();
    expect(title).toBe(HOW_I_WORK_TITLE);
    expect(body.length).toBeGreaterThan(3000);
    expect(body.length).toBeLessThanOrEqual(LONG_LIMIT);
    const { violations } = lintVoice(body, { citationCap: 8 });
    expect(violations).toEqual([]);
  });

  it("embeds cost-bound defaults and the full tag vocabulary from code", () => {
    const { body } = generateHowIWorkArticle();
    expect(body).toContain(DEFAULT_DAILY_TOKEN_BUDGET.toLocaleString("en-US"));
    expect(body).toContain(DEFAULT_USER_DAILY_TOKEN_BUDGET.toLocaleString("en-US"));
    expect(body).toContain(`$${DEFAULT_MODEL_PRICE_PER_MTOK_IN}/1M`);
    expect(body).toContain(`$${DEFAULT_MODEL_PRICE_PER_MTOK_OUT}/1M`);
    expect(body).toContain(SKIP_NOTICE_TEXT.budget);
    expect(body).toContain(`capped at ${DEFAULT_PROACTIVE_MAX_PER_DAY} per UTC day`);
    for (const label of REPLY_TAG_VOCABULARY) expect(body).toContain(`- ${label}:`);
    for (const label of ARTIFACT_TAG_VOCAB) expect(body).toContain(`- ${label}:`);
  });

  it("matches content/how-i-work.json (regenerate with npm run how-i-work)", () => {
    const expected = generateHowIWorkFileText();
    const onDisk = readFileSync(path.join(repoRoot, HOW_I_WORK_RELATIVE_PATH), "utf8");
    expect(onDisk).toBe(expected);
  });

  it("npm run content:check exits 0 against the generated file", async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"),
      path.join(repoRoot, "scripts", "how-i-work.ts"),
      "--check",
    ], { cwd: repoRoot, timeout: 30_000 });
    expect(stdout).toMatch(/matches generated/);
  });
});
