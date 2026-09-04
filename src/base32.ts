/**
 * Base32 encoders used by the secret scrubber to enumerate encodings of the
 * configured key material (a known 32-byte value has a finite set of common
 * encodings; matching them by shape is impossible, matching them by value is
 * trivial). No runtime dependency provides these, so they live here.
 */

const RFC4648_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const ZBASE32_ALPHABET = "ybndrfg8ejkmcpqxot1uwisza345h769";

function encode(bytes: Uint8Array, alphabet: string, padding: boolean): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  if (padding) while (out.length % 8 !== 0) out += "=";
  return out;
}

/** RFC 4648 base32, uppercase, padded by default. */
export function base32Encode(bytes: Uint8Array, opts?: { padding?: boolean }): string {
  return encode(bytes, RFC4648_ALPHABET, opts?.padding ?? true);
}

/** z-base-32 (ZeroMQ Z85-style alphabet used by pkarr/pubky ids), never padded. */
export function zbase32Encode(bytes: Uint8Array): string {
  return encode(bytes, ZBASE32_ALPHABET, false);
}
