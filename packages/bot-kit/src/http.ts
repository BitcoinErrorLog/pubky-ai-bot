const MAX_BYTES = 1_000_000;

export async function fetchJson(
  url: URL,
  timeoutMs: number,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; body: unknown; headers: Headers }> {
  return fetchJsonWith(url, timeoutMs, { method: "GET", headers: extraHeaders });
}

export async function postJson(
  url: URL,
  timeoutMs: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; body: unknown; headers: Headers }> {
  return fetchJsonWith(url, timeoutMs, {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
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
    // F-04: never follow redirects — the configured-host SSRF guarantee would
    // otherwise hold only for the first hop.
    const res = await fetch(url, { ...init, signal: ac.signal, redirect: "error" });
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
