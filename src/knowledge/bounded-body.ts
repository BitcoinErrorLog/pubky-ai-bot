/** Read a fetch Response body with a hard byte cap, before buffering the whole payload. */

export async function readResponseBodyCapped(res: Response, maxBytes: number): Promise<Buffer> {
  const cl = res.headers.get("content-length");
  if (cl) {
    const n = Number(cl);
    if (Number.isFinite(n) && n > maxBytes) {
      if (res.body) await res.body.cancel().catch(() => undefined);
      throw new Error(`http source too large (> ${maxBytes} bytes)`);
    }
  }
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) throw new Error(`http source too large (> ${maxBytes} bytes)`);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`http source too large (> ${maxBytes} bytes)`);
      }
      chunks.push(value);
    }
  } catch (e) {
    await reader.cancel().catch(() => undefined);
    throw e;
  }
  return Buffer.concat(chunks);
}
