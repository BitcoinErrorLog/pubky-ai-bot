#!/usr/bin/env npx tsx
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateCostBoundsMarkdown } from "../src/cost-bounds.js";

const text = generateCostBoundsMarkdown();
process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
if (process.argv.includes("--write")) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  writeFileSync(join(root, "docs/cost-bounds.md"), text.endsWith("\n") ? text : `${text}\n`, "utf8");
}
