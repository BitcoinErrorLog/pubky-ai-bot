/**
 * Shared text normalization applied BEFORE every secret/injection scan
 * (secret scrubber, tool-screen via redactSecrets, extraction guard).
 *
 * - NFKC folds compatibility homoglyphs (fullwidth digits/letters, ligatures,
 *   circled chars) to their canonical ASCII forms, so a secret spelled with
 *   fullwidth hex (U+FF10.. / U+FF41..) scans the same as plain hex.
 * - Unicode format chars (Cf: zero-width space/joiners, BOM, soft hyphen,
 *   bidi controls) are stripped, so zero-width-separated secrets rejoin.
 * - C0/C1 control chars other than \t \n \r are stripped.
 *
 * Case is preserved: callers that need case-insensitive matching lowercase
 * the result themselves.
 */
export function normalizeForScan(text: string): string {
  let out = text.normalize("NFKC");
  out = out.replace(/\p{Cf}/gu, "");
  // eslint-disable-next-line no-control-regex
  out = out.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  return out;
}
