/**
 * Crockford Base32 post ids (pubky-app-specs `validate_crockford_id`).
 * A 13-character id decodes to 8 big-endian bytes: microseconds since epoch.
 */

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const PUBKY_POST_ID_RE = /^[0-9A-HJKMNP-TV-Z]{13}$/;
export const PUBKY_POST_ID_MIN_MS = Date.UTC(2024, 9, 1);
export const PUBKY_POST_ID_FUTURE_SLACK_MS = 2 * 60 * 60 * 1000;

function crockfordValue(ch: string): number | null {
  const c = ch.toUpperCase();
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

/** Unix ms encoded in a post id, or null if the id is not a plausible timestamp. */
export function timestampMsFromPostId(id: string, nowMs = Date.now()): number | null {
  if (!PUBKY_POST_ID_RE.test(id)) return null;
  const bytes = decodeCrockfordId(id);
  if (!bytes) return null;
  let us = 0n;
  for (const b of bytes) us = (us << 8n) | BigInt(b);
  const ms = Number(us / 1000n);
  // Mirrors pubky-app-specs 0.7.0 `TimestampId::validate_id`: strict
  // Crockford alphabet, timestamp after 2024-10-01, and no more than two
  // hours ahead of the validating clock.
  if (!Number.isFinite(ms) || ms <= PUBKY_POST_ID_MIN_MS || ms > nowMs + PUBKY_POST_ID_FUTURE_SLACK_MS) return null;
  return ms;
}

/** Encode unix microseconds as a 13-char post id (8-byte big-endian). */
export function postIdFromUnixUs(us: bigint): string {
  const bytes = new Uint8Array(8);
  let x = us;
  for (let i = 7; i >= 0; i--) {
    bytes[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return encodeCrockfordId(bytes);
}

/** Encode unix milliseconds as a 13-char post id (microseconds, big-endian). */
export function postIdFromUnixMs(ms: number): string {
  return postIdFromUnixUs(BigInt(Math.floor(ms)) * 1000n);
}

/**
 * Process-local strictly increasing microsecond ids. The specs builder
 * stamps millisecond-resolution timestamps, so two createPost calls in the
 * same millisecond share an id; enqueue must not.
 */
let lastAllocatedUs = 0n;

export function allocateUniquePostId(nowMs = Date.now()): string {
  let us = BigInt(Math.floor(nowMs)) * 1000n;
  if (us <= lastAllocatedUs) us = lastAllocatedUs + 1n;
  lastAllocatedUs = us;
  return postIdFromUnixUs(us);
}

/** Reject id-time vs indexed_at when they diverge by more than this slack. */
export const POST_TIME_SLACK_MS = 60 * 60 * 1000;

export function postTimestampMs(opts: {
  postId: string;
  indexedAt?: number | null;
  createdAt?: number | null;
}): number | null {
  const fromId = timestampMsFromPostId(opts.postId);
  const indexed =
    typeof opts.indexedAt === "number" && Number.isFinite(opts.indexedAt) && opts.indexedAt > 0
      ? opts.indexedAt
      : null;
  if (fromId !== null && indexed !== null && Math.abs(fromId - indexed) > POST_TIME_SLACK_MS) {
    return null;
  }
  if (fromId !== null) return fromId;
  if (typeof opts.createdAt === "number" && Number.isFinite(opts.createdAt) && opts.createdAt > 0) {
    return opts.createdAt;
  }
  return indexed;
}
