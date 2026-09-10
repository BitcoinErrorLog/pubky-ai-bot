import { blake3 } from "@noble/hashes/blake3";

/**
 * Mirrors pubky-nexus commit eb90b176 (PR #972):
 * nexus-common/src/universal_tag/normalize.rs.
 * normalize.rs is unchanged from 9379bf5 through 149f57da (2026-09-10);
 * #972 fixed the resource-tag DELETE retry double-decrement, not identity.
 * Keep this byte-identical to that cross-implementation resource contract.
 */
export function normalizeUri(raw: string): string {
  const colon = raw.indexOf(":");
  if (colon < 1) throw new Error("invalid URI");
  const scheme = raw.slice(0, colon);
  if (!/^[A-Za-z][A-Za-z0-9+.-]*$/.test(scheme)) throw new Error("invalid URI scheme");
  const normalizedScheme = scheme.toLowerCase();
  const remainder = raw.slice(colon + 1);
  const fragment = remainder.indexOf("#");
  const withoutFragment = fragment >= 0 ? remainder.slice(0, fragment) : remainder;

  if (!remainder.startsWith("//")) return `${normalizedScheme}:${withoutFragment}`;

  const parsed = new URL(raw);
  const hostname = parsed.hostname.toLowerCase();
  const port =
    (normalizedScheme === "http" && parsed.port === "80") ||
    (normalizedScheme === "https" && parsed.port === "443")
      ? ""
      : parsed.port;
  const query = withoutFragment.indexOf("?");
  const exactQuery = query >= 0 ? withoutFragment.slice(query) : "";
  return `${normalizedScheme}://${hostname}${port ? `:${port}` : ""}${parsed.pathname || "/"}${exactQuery}`;
}

export function resourceIdentity(normalizedValue: string): string {
  return Buffer.from(blake3(new TextEncoder().encode(normalizedValue)).subarray(0, 16)).toString("hex");
}
