import { MAX_CHUNK_CHARS, PROSE_OVERLAP_CHARS, type Chunk } from "./types.js";

export const INDEX_TEXT_VERSION = "index-v2-title";

export function documentTitle(filePath: string, text: string): string {
  const h1 = /^#\s+(.+)$/m.exec(text);
  if (h1?.[1]) return h1[1].trim();
  const base = filePath.replaceAll("\\", "/").split("/").pop() ?? filePath;
  return base.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim() || "untitled";
}

export function documentIndexHashInput(relPath: string, text: string): string {
  return `${INDEX_TEXT_VERSION}\n${relPath}\n${text}`;
}

function headingPath(stack: Array<{ level: number; text: string }>): string {
  return stack.map((h) => h.text).join(" > ");
}

function withPrefix(title: string, sectionPath: string, body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "";
  const path = sectionPath && sectionPath !== title ? `${title} > ${sectionPath}` : title || sectionPath;
  if (!path) return trimmed;
  if (trimmed.startsWith(path)) return trimmed;
  return `${path}\n\n${trimmed}`;
}

function splitOversized(
  text: string,
  kind: Chunk["kind"],
  startOrdinal: number,
  overlap: boolean,
  prefix: string,
): Chunk[] {
  const out: Chunk[] = [];
  const prefixed = prefix ? withPrefix(prefix, prefix, text) : text.trim();
  if (!prefixed) return out;
  if (prefixed.length <= MAX_CHUNK_CHARS) {
    out.push({ content: prefixed, ordinal: startOrdinal, kind });
    return out;
  }
  const body = text.trim();
  const head = prefix ? `${prefix}\n\n` : "";
  const budget = Math.max(400, MAX_CHUNK_CHARS - head.length);
  const step = overlap ? Math.max(200, budget - PROSE_OVERLAP_CHARS) : budget;
  let i = 0;
  let ord = startOrdinal;
  while (i < body.length) {
    const slice = body.slice(i, i + budget).trim();
    if (slice) {
      out.push({ content: `${head}${slice}`.trim(), ordinal: ord, kind });
      ord += 1;
    }
    i += step;
    if (!overlap && i < body.length && step === 0) break;
  }
  return out;
}

export function chunkMarkdown(text: string, title?: string): Chunk[] {
  const docTitle = title ?? documentTitle("", text);
  const lines = text.split("\n");
  const stack: Array<{ level: number; text: string }> = [];
  const sections: Array<{ path: string; body: string }> = [];
  let buf: string[] = [];
  const flush = () => {
    const body = buf.join("\n").trim();
    if (body) sections.push({ path: headingPath(stack) || docTitle, body });
    buf = [];
  };
  for (const line of lines) {
    const m = /^(#{1,6})\s+(.+)$/.exec(line);
    if (m) {
      flush();
      const level = m[1].length;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, text: m[2].trim() });
      buf = [line];
    } else {
      buf.push(line);
    }
  }
  flush();
  const chunks: Chunk[] = [];
  for (const section of sections.length ? sections : [{ path: docTitle, body: text }]) {
    chunks.push(...splitOversized(section.body, "markdown", chunks.length, true, section.path || docTitle));
  }
  return chunks;
}

export function chunkCode(text: string, title?: string): Chunk[] {
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
  const prefix = title ?? "";
  const chunks: Chunk[] = [];
  for (const item of items.length ? items : [text]) {
    chunks.push(...splitOversized(item, "code", chunks.length, false, prefix));
  }
  return chunks;
}

export function chunkMapping(text: string, title?: string): Chunk[] {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    obj = parseSimpleYamlMap(text);
  }
  const prefix = title ?? "";
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    const chunks: Chunk[] = [];
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const body = `${key}:\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`;
      chunks.push(...splitOversized(body, "mapping", chunks.length, false, prefix ? `${prefix} > ${key}` : key));
    }
    return chunks.length ? chunks : splitOversized(text, "mapping", 0, false, prefix);
  }
  return splitOversized(text, "mapping", 0, false, prefix);
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
  const title = documentTitle(filePath, text);
  if (lower.endsWith(".md") || lower.endsWith(".mdx")) return chunkMarkdown(text, title);
  if (lower.endsWith(".json") || lower.endsWith(".yaml") || lower.endsWith(".yml")) return chunkMapping(text, title);
  if (/\.(ts|tsx|js|jsx|rs|py|go|c|h|swift|kt)$/.test(lower)) return chunkCode(text, title);
  return splitOversized(text, "prose", 0, true, title);
}
