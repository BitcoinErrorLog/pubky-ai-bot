const URL_RE = /https?:\/\/[^\s<>"'`)\]}]+/gi;

export function stripTrailingPunct(raw: string): string {
  return raw.replace(/[.,;:!?)]+$/g, "");
}

export function collectHttpUrls(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (typeof value === "string") {
    for (const m of value.match(URL_RE) ?? []) {
      into.add(stripTrailingPunct(m));
    }
    return into;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectHttpUrls(item, into);
    return into;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) collectHttpUrls(v, into);
  }
  return into;
}

export function titlesByUrl(value: unknown, map: Map<string, string> = new Map()): Map<string, string> {
  if (Array.isArray(value)) {
    for (const item of value) titlesByUrl(item, map);
    return map;
  }
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    const url = typeof o.url === "string" ? o.url : typeof o.uri === "string" ? o.uri : undefined;
    const title = typeof o.title === "string" ? o.title : undefined;
    if (url && /^https?:\/\//i.test(url) && title) map.set(stripTrailingPunct(url), title);
    for (const v of Object.values(o)) titlesByUrl(v, map);
  }
  return map;
}

export function sourceDomain(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}
