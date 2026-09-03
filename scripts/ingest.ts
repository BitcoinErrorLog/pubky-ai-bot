#!/usr/bin/env npx tsx
import { runKnowledgeIngest } from "../src/knowledge/run-ingest.js";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("-")) return process.argv[i + 1];
  return undefined;
}

const sourceFilter = argValue("--source");
const full = process.argv.includes("--full");
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const result = await runKnowledgeIngest({ databaseUrl: url, full, sourceFilter });
if (!result.ok) {
  console.error(result.error);
  process.exit(1);
}
console.log(JSON.stringify(result.report, null, 2));
