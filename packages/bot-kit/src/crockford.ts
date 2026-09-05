/**
 * Crockford Base32 post ids (pubky-app-specs `validate_crockford_id`).
 * A 13-character id decodes to 8 big-endian bytes: microseconds since epoch.
 */

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function crockfordValue(ch: string): number | null {
  const c = ch.toUpperCase();
  if (c === "O") return 0;
  if (c === "I" || c === "L") return 1;
  if (c === "U") return null;
  const i = CROCKFORD.indexOf(c);
  return i >= 0 ? i : null;
}

/** Decode a 13-char Crockford id to 8 bytes. Null on bad length or alphabet. */
export function decodeCrockfordId(id: string): Uint8Array | null {
  if (id.length !== 13) return null;
  let acc = 0n;
  let nbits = 0;
  const bytes: number[] = [];
  for (const ch of id) {
    const v = crockfordValue(ch);
    if (v === null) return null;
    acc = (acc << 5n) | BigInt(v);
    nbits += 5;
    while (nbits >= 8) {
      nbits -= 8;
      bytes.push(Number((acc >> BigInt(nbits)) & 0xffn));
      acc &= (1n << BigInt(nbits)) - 1n;
    }
  }
  if (bytes.length !== 8) return null;
  return Uint8Array.from(bytes);
}

/** Encode 8 bytes as a 13-char Crockford id (MSB first, leftover bits padded). */
export function encodeCrockfordId(bytes: Uint8Array): string {
  if (bytes.length !== 8) throw new Error("crockford id encodes exactly 8 bytes");
  let acc = 0n;
  let nbits = 0;
  let out = "";
  for (const b of bytes) {
    acc = (acc << 8n) | BigInt(b);
    nbits += 8;
    while (nbits >= 5) {
      nbits -= 5;
      out += CROCKFORD[Number((acc >> BigInt(nbits)) & 31n)];
      acc &= (1n << BigInt(nbits)) - 1n;
    }
  }
  if (nbits > 0) out += CROCKFORD[Number((acc << BigInt(5 - nbits)) & 31n)];
  return out;
}

const MS_2020 = Date.UTC(2020, 0, 1);
const MS_2050 = Date.UTC(2050, 0, 1);

/** Unix ms encoded in a post id, or null if the id is not a plausible timestamp. */
export function timestampMsFromPostId(id: string): number | null {
  const bytes = decodeCrockfordId(id);
  if (!bytes) return null;
  let us = 0n;
  for (const b of bytes) us = (us << 8n) | BigInt(b);
  const ms = Number(us / 1000n);
  if (!Number.isFinite(ms) || ms < MS_2020 || ms > MS_2050) return null;
  return ms;
}

/** Encode unix milliseconds as a 13-char post id (microseconds, big-endian). */
export function postIdFromUnixMs(ms: number): string {
  const us = BigInt(Math.floor(ms)) * 1000n;
  const bytes = new Uint8Array(8);
  let x = us;
  for (let i = 7; i >= 0; i--) {
    bytes[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return encodeCrockfordId(bytes);
}

export function postTimestampMs(opts: {
  postId: string;
  indexedAt?: number | null;
  createdAt?: number | null;
}): number | null {
  const fromId = timestampMsFromPostId(opts.postId);
  if (fromId !== null) return fromId;
  if (typeof opts.createdAt === "number" && Number.isFinite(opts.createdAt) && opts.createdAt > 0) {
    return opts.createdAt;
  }
  if (typeof opts.indexedAt === "number" && Number.isFinite(opts.indexedAt) && opts.indexedAt > 0) {
    return opts.indexedAt;
  }
  return null;
}
