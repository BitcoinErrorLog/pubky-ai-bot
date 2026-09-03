const MAX_BYTES = 1_000_000;

export async function fetchJson(url: URL, timeoutMs: number): Promise<{ status: number; body: unknown }> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    const text = await res.text();
    if (text.length > MAX_BYTES) throw new Error("nexus response too large");
    if (!text) return { status: res.status, body: null };
    return { status: res.status, body: JSON.parse(text) as unknown };
  } finally {
    clearTimeout(t);
  }
}
