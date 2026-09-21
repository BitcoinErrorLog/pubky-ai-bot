#!/usr/bin/env node
/**
 * Literal §7 swap proof:
 *   node scripts/brain-swap-proof.mjs --a moonshot --b ollama --assert-hash-equality --assert-no-provider-state
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const a = process.argv.includes("--a") ? process.argv[process.argv.indexOf("--a") + 1] : "";
const b = process.argv.includes("--b") ? process.argv[process.argv.indexOf("--b") + 1] : "";

if (!args.has("--assert-hash-equality") || !args.has("--assert-no-provider-state")) {
  console.error("required: --assert-hash-equality --assert-no-provider-state");
  process.exit(2);
}
if (a !== "moonshot" || b !== "ollama") {
  console.error("required: --a moonshot --b ollama");
  process.exit(2);
}

const result = spawnSync(
  join(root, "node_modules/.bin/vitest"),
  ["run", "packages/bot-kit/src/brain/brain.test.ts", "src/pubchi/brain-swap.test.ts"],
  { cwd: root, stdio: "inherit", env: process.env },
);
process.exit(result.status ?? 1);
