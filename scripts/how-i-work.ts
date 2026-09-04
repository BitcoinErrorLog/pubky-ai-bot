#!/usr/bin/env npx tsx
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateHowIWorkFileText, HOW_I_WORK_RELATIVE_PATH } from "../src/how-i-work.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outPath = join(root, HOW_I_WORK_RELATIVE_PATH);

function main(): void {
  const text = generateHowIWorkFileText();
  const check = process.argv.includes("--check");
  const write = process.argv.includes("--write") || !check;
  if (check) {
    let onDisk: string;
    try {
      onDisk = readFileSync(outPath, "utf8");
    } catch {
      process.stderr.write(`${HOW_I_WORK_RELATIVE_PATH} is missing; run npm run how-i-work\n`);
      process.exit(1);
      return;
    }
    if (onDisk !== text) {
      process.stderr.write(
        `${HOW_I_WORK_RELATIVE_PATH} is stale; regenerate with npm run how-i-work (code is the source of truth)\n`,
      );
      process.exit(1);
    }
    process.stdout.write(`${HOW_I_WORK_RELATIVE_PATH} matches generated How I work article\n`);
    return;
  }
  if (write) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, text, "utf8");
  }
  process.stdout.write(text);
}

main();
