#!/usr/bin/env npx tsx
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ANNOUNCEMENT_RELATIVE_PATH, generateAnnouncementFileText } from "../src/announcement.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outPath = join(root, ANNOUNCEMENT_RELATIVE_PATH);

function main(): void {
  const text = generateAnnouncementFileText();
  const check = process.argv.includes("--check");
  const write = process.argv.includes("--write") || !check;
  if (check) {
    let onDisk: string;
    try {
      onDisk = readFileSync(outPath, "utf8");
    } catch {
      process.stderr.write(`${ANNOUNCEMENT_RELATIVE_PATH} is missing; run npm run announcement\n`);
      process.exit(1);
      return;
    }
    if (onDisk !== text) {
      process.stderr.write(
        `${ANNOUNCEMENT_RELATIVE_PATH} is stale; regenerate with npm run announcement (code is the source of truth)\n`,
      );
      process.exit(1);
    }
    process.stdout.write(`${ANNOUNCEMENT_RELATIVE_PATH} matches generated announcement article\n`);
    return;
  }
  if (write) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, text, "utf8");
  }
  process.stdout.write(text);
}

main();
