#!/usr/bin/env npx tsx
/**
 * Voice evaluation (docs/voice.md), separate from correctness evals.
 *
 * Offline (always): run the composition path (parseModes -> composeReply,
 * which includes the deterministic voice linter) on each item's draft and
 * check the forbidden/required regexes against the final reply text.
 *
 * Live (when JEB_MODEL_API_KEY is set): also ask the model for a real
 * answer to each prompt and check the same patterns against what would be
 * published.
 *
 * Output: per-rule violation table. Exit 1 on any offline escape (the
 * linter should have caught it) or missing required pattern; live escapes
 * are reported but do not fail the run (they measure model drift).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { composeReply } from "../src/compose.js";
import { parseModes } from "../src/modes.js";
import { forbiddenHits } from "../src/voice.js";
import { EVAL_ASKER_PK, EVAL_BOT_PK_FALLBACK, evalMentionUri } from "./eval-lib.js";

const patternSchema = z.object({ name: z.string().min(1), pattern: z.string().min(1) });
const itemSchema = z.object({
  id: z.string().min(1),
  prompt: z.string().min(1),
  context: z.string().min(1),
  draft: z.string(),
  forbidden: z.array(patternSchema).default([]),
  required: z.array(patternSchema).default([]),
});
const fileSchema = z.object({ items: z.array(itemSchema).min(1) });
type VoiceItem = z.infer<typeof itemSchema>;

interface ItemResult {
  id: string;
  escapes: string[];
  missing: string[];
  linterCaught: string[];
}

function repoRoot(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function loadItems(): VoiceItem[] {
  const dir = path.join(repoRoot(), "eval", "voice");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".yaml") && !f.startsWith("._"));
  const items: VoiceItem[] = [];
  for (const file of files.sort()) {
    const parsed = fileSchema.parse(parseYaml(fs.readFileSync(path.join(dir, file), "utf8")));
    items.push(...parsed.items);
  }
  return items;
}

function checkText(item: VoiceItem, text: string): { escapes: string[]; missing: string[] } {
  const escapes = forbiddenHits(text, item.forbidden, item.id).map((h) => h.rule);
  const missing: string[] = [];
  for (const req of item.required) {
    let rx: RegExp;
    try {
      rx = new RegExp(req.pattern, "imsu");
    } catch {
      missing.push(`${req.name} (invalid regex)`);
      continue;
    }
    if (!rx.test(text)) missing.push(req.name);
  }
  return { escapes, missing };
}

function perRuleTable(results: ItemResult[]): string {
  const byRule = new Map<string, { items: Set<string> }>();
  for (const r of results) {
    for (const rule of [...r.escapes, ...r.missing.map((m) => `required:${m}`)]) {
      const cell = byRule.get(rule) ?? { items: new Set<string>() };
      cell.items.add(r.id);
      byRule.set(rule, cell);
    }
  }
  const lines = ["| Rule | Violations | Items |", "| --- | --- | --- |"];
  if (byRule.size === 0) {
    lines.push("| (none) | 0 | - |");
  } else {
    for (const [rule, cell] of [...byRule.entries()].sort((a, b) => b[1].items.size - a[1].items.size)) {
      lines.push(`| ${rule} | ${cell.items.size} | ${[...cell.items].join(", ")} |`);
    }
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const items = loadItems();
  if (items.length < 30) throw new Error(`voice eval requires at least 30 items, found ${items.length}`);

  const offline: ItemResult[] = [];
  for (const item of items) {
    const composed = composeReply(item.draft, parseModes(item.prompt), []);
    const { escapes, missing } = checkText(item, composed.content);
    offline.push({
      id: item.id,
      escapes,
      missing,
      linterCaught: [...new Set(composed.violations.map((v) => v.rule))],
    });
  }

  const totalEscapes = offline.reduce((n, r) => n + r.escapes.length, 0);
  const totalMissing = offline.reduce((n, r) => n + r.missing.length, 0);
  const caught = offline.reduce((n, r) => n + r.linterCaught.length, 0);

  console.log(`# Voice eval — offline composition path (${items.length} items)`);
  console.log("");
  console.log(`linter violations caught and fixed: ${caught}`);
  console.log(`forbidden-pattern escapes after linting: ${totalEscapes}`);
  console.log(`missing required patterns after linting: ${totalMissing}`);
  console.log("");
  console.log(perRuleTable(offline.filter((r) => r.escapes.length || r.missing.length)));

  if (process.env.JEB_MODEL_API_KEY?.trim()) {
    const { answerMention } = await import("../src/answer.js");
    const { configFromProcessEnv } = await import("../src/config.js");
    const { Nexus } = await import("../src/nexus.js");
    if (!process.env.DATABASE_URL?.trim()) {
      process.env.DATABASE_URL =
        process.env.JEB_EVAL_DATABASE_URL?.trim() || "postgres://johncarvalho@127.0.0.1:5432/jeb_eval";
    }
    const cfg = configFromProcessEnv({ requireSecret: false, role: "reason" });
    const nexus = new Nexus(cfg.nexusUrl, cfg.nexusTimeoutMs);
    const botPk = cfg.botPk && /^[a-z0-9]{52}$/.test(cfg.botPk) ? cfg.botPk : EVAL_BOT_PK_FALLBACK;
    const live: ItemResult[] = [];
    const errorIds: string[] = [];
    for (const item of items) {
      const mention = {
        uri: evalMentionUri(item.id, botPk),
        createdAt: Date.now(),
        author: EVAL_ASKER_PK,
        name: "voice-eval",
        content: item.prompt.replace(/pubkyBOTPK/g, `pubky${botPk}`),
      };
      try {
        const result = await answerMention(cfg, nexus, botPk, mention, [mention]);
        const { escapes, missing } = checkText(item, result.content ?? "");
        live.push({ id: item.id, escapes, missing, linterCaught: result.violations.map((v) => v.rule) });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errorIds.push(item.id);
        live.push({ id: item.id, escapes: [`error:${msg}`], missing: [], linterCaught: [] });
        console.error(`LIVE ERROR: ${item.id}: ${msg}`);
      }
    }
    const liveEscapes = live.reduce((n, r) => n + r.escapes.length, 0);
    const liveMissing = live.reduce((n, r) => n + r.missing.length, 0);
    console.log("");
    console.log(`# Voice eval — live model answers (report only)`);
    console.log("");
    console.log(`forbidden-pattern escapes: ${liveEscapes}; missing required patterns: ${liveMissing}`);
    console.log(`errors: ${errorIds.length}${errorIds.length ? ` (${errorIds.join(", ")})` : ""}`);
    console.log("");
    console.log(perRuleTable(live.filter((r) => r.escapes.length || r.missing.length)));
  } else {
    console.log("");
    console.log("(live model pass skipped: JEB_MODEL_API_KEY not set)");
  }

  if (totalEscapes > 0 || totalMissing > 0) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
