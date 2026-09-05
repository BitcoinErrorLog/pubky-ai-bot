import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DraftRow } from "./types.js";

export function draftMarkdownFilename(row: DraftRow): string {
  return `${String(row.id).padStart(4, "0")}-${row.format}.md`;
}

export function renderDraftMarkdown(row: DraftRow): string {
  const created = row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at);
  const uris = row.evidence.uris ?? [];
  const lines = [
    `# Draft ${row.id}`,
    "",
    `- format: ${row.format}`,
    `- generated: ${created}`,
    `- status: ${row.status}`,
    `- evidence:`,
    ...uris.map((u) => `  - ${u}`),
    "",
    "---",
    "",
    row.body.trimEnd(),
    "",
  ];
  return lines.join("\n");
}

export function writeDraftMarkdownFiles(rows: DraftRow[], outDir: string): string[] {
  mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  for (const row of rows) {
    const dest = path.join(outDir, draftMarkdownFilename(row));
    writeFileSync(dest, renderDraftMarkdown(row), "utf8");
    written.push(dest);
  }
  return written;
}
