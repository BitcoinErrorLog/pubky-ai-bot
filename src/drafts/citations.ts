const URL_IN_TEXT = /https?:\/\/[^\s)>\]]+/gi;

export function normalizeHref(raw: string): string {
  return raw.trim().replace(/[.,;:!?]+$/, "").replace(/\/$/, "");
}

export function hrefAllowed(href: string, allowed: Set<string>): boolean {
  const n = normalizeHref(href);
  if (allowed.has(n)) return true;
  for (const a of allowed) {
    if (n.startsWith(`${a}/`) || a.startsWith(`${n}/`)) return true;
  }
  return false;
}

/**
 * Drop a bullet (or whole line that is only a citation) when it cites a URL
 * outside the evidence set. Unknown inline URLs are stripped; the line stays
 * if leftover text remains.
 */
export function dropUnknownCitations(body: string, allowed: Set<string>): string {
  const lines = body.split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    const urls = line.match(URL_IN_TEXT) ?? [];
    if (urls.length === 0) {
      kept.push(line);
      continue;
    }
    const bad = urls.filter((u) => !hrefAllowed(u, allowed));
    if (bad.length === 0) {
      kept.push(line);
      continue;
    }
    const isBullet = /^\s*[-*]\s+/.test(line);
    if (isBullet) continue;
    let cleaned = line;
    for (const u of bad) cleaned = cleaned.replace(u, "");
    cleaned = cleaned.replace(/\s{2,}/g, " ").trimEnd();
    if (cleaned.trim()) kept.push(cleaned);
  }
  return kept.join("\n");
}

export function extractHttpHrefs(text: string): string[] {
  return (text.match(URL_IN_TEXT) ?? []).map(normalizeHref);
}
