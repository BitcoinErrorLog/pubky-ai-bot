import { MAX_CHUNK_CHARS, PROSE_OVERLAP_CHARS, type Chunk } from "./types.js";

function splitOversized(text: string, kind: Chunk["kind"], startOrdinal: number, overlap: boolean): Chunk[] {
  const out: Chunk[] = [];
  if (text.length <= MAX_CHUNK_CHARS) {
    if (text.trim()) out.push({ content: text.trim(), ordinal: startOrdinal, kind });
    return out;
  }
  const step = overlap ? MAX_CHUNK_CHARS - PROSE_OVERLAP_CHARS : MAX_CHUNK_CHARS;
  let i = 0;
  let ord = startOrdinal;
  while (i < text.length) {
    const slice = text.slice(i, i + MAX_CHUNK_CHARS).trim();
    if (slice) {
      out.push({ content: slice, ordinal: ord, kind });
      ord += 1;
    }
    i += step;
    if (!overlap && i < text.length && step === 0) break;
  }
  return out;
}

export function chunkMarkdown(text: string): Chunk[] {
  const parts = text.split(/^(#{1,6} .+)$/m);
  const sections: string[] = [];
  let current = parts[0] ?? "";
  for (let i = 1; i < parts.length; i += 2) {
    if (current.trim()) sections.push(current.trim());
    current = `${parts[i]}\n${parts[i + 1] ?? ""}`;
  }
  if (current.trim()) sections.push(current.trim());
  const chunks: Chunk[] = [];
  for (const section of sections.length ? sections : [text]) {
    chunks.push(...splitOversized(section, "markdown", chunks.length, true));
  }
  return chunks;
}

export function chunkCode(text: string): Chunk[] {
  const start =
    /^(export\s+)?(default\s+)?(async\s+)?(function|class|const|let|type|interface|enum)\b|^pub\s+|^(async\s+)?fn\s|^struct\s|^impl\s|^enum\s|^mod\s/;
  const items: string[] = [];
  let buf: string[] = [];
  for (const line of text.split("\n")) {
    if (start.test(line) && buf.join("\n").trim()) {
      items.push(buf.join("\n").trim());
      buf = [line];
    } else {
      buf.push(line);
    }
  }
  if (buf.join("\n").trim()) items.push(buf.join("\n").trim());
  const chunks: Chunk[] = [];
  for (const item of items.length ? items : [text]) {
    chunks.push(...splitOversized(item, "code", chunks.length, false));
  }
  return chunks;
}

export function chunkMapping(text: string): Chunk[] {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    obj = parseSimpleYamlMap(text);
  }
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    const chunks: Chunk[] = [];
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const body = `${key}:\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`;
      chunks.push(...splitOversized(body, "mapping", chunks.length, false));
    }
    return chunks.length ? chunks : splitOversized(text, "mapping", 0, false);
  }
  return splitOversized(text, "mapping", 0, false);
}

function parseSimpleYamlMap(text: string): Record<string, string> | null {
  const lines = text.split("\n");
  const map: Record<string, string> = {};
  let key: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (key !== null) map[key] = buf.join("\n").trim();
    buf = [];
  };
  for (const line of lines) {
    const m = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
    if (m && !line.startsWith(" ") && !line.startsWith("\t")) {
      flush();
      key = m[1];
      buf = [m[2]];
    } else if (key !== null) {
      buf.push(line);
    }
  }
  flush();
  return Object.keys(map).length ? map : null;
}

export function chunkFile(filePath: string, text: string): Chunk[] {
  const lower = filePath.replaceAll("\\", "/").toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".mdx")) return chunkMarkdown(text);
  if (lower.endsWith(".json") || lower.endsWith(".yaml") || lower.endsWith(".yml")) return chunkMapping(text);
  if (/\.(ts|tsx|js|jsx|rs|py|go|c|h|swift|kt)$/.test(lower)) return chunkCode(text);
  return splitOversized(text, "prose", 0, true);
}
