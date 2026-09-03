const MAX_BYTES = 1_000_000;

export async function fetchJson(url: URL, timeoutMs: number): Promise<{ status: number; body: unknown }> {
  return fetchJsonWith(url, timeoutMs, { method: "GET" });
}

export async function postJson(
  url: URL,
  timeoutMs: number,
  body: unknown,
): Promise<{ status: number; body: unknown; headers: Headers }> {
  return fetchJsonWith(url, timeoutMs, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function fetchJsonWith(
  url: URL,
  timeoutMs: number,
  init: RequestInit,
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ac.signal });
    const text = await res.text();
    if (text.length > MAX_BYTES) throw new Error("response too large");
    if (!text) return { status: res.status, body: null, headers: res.headers };
    try {
      return { status: res.status, body: JSON.parse(text) as unknown, headers: res.headers };
    } catch {
      return { status: res.status, body: { error: "NON_JSON", message: text.slice(0, 400) }, headers: res.headers };
    }
  } finally {
    clearTimeout(t);
  }
}
