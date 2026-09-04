#!/usr/bin/env npx tsx
import { writeFileSync } from "node:fs";
import { Store } from "../src/db.js";
import { dashboardJson, formatDashboardMarkdown, parseDashboardArgv, parseSince } from "../src/dashboard-report.js";
import { policyLimitsFromEnv, policySummary } from "../src/policy-summary.js";
import { collectDashboardFacts } from "../src/reporting.js";

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const args = parseDashboardArgv(process.argv.slice(2));
let window;
try {
  window = parseSince(args.sinceRaw);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}

const policy = policySummary(policyLimitsFromEnv());
const store = new Store(url);
try {
  const facts = await collectDashboardFacts(store.pool, window, policy.dailyTokenBudget);
  const text = args.json
    ? JSON.stringify(dashboardJson(facts, policy), null, 2)
    : formatDashboardMarkdown(facts, policy);
  if (args.markdownFile) {
    writeFileSync(args.markdownFile, args.json ? formatDashboardMarkdown(facts, policy) : text, "utf8");
  }
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
} finally {
  await store.close();
}
