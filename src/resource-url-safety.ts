import { isIP } from "node:net";
import { domainToUnicode } from "node:url";

const QUERY_KEY_ALLOWLIST = new Set([
  "b",
  "filter",
  "lang",
  "locale",
  "page",
  "q",
  "ref",
  "sort",
  "tab",
  "v",
  "view",
]);
const CREDENTIAL_QUERY_TOKENS = new Set([
  "access_key",
  "access_token",
  "api_key",
  "apikey",
  "auth",
  "auth_token",
  "authorization",
  "bearer",
  "client_secret",
  "credential",
  "id_token",
  "jwt",
  "key",
  "password",
  "passwd",
  "private_key",
  "refresh_token",
  "secret",
  "session",
  "sig",
  "signature",
  "token",
]);
const CREDENTIAL_QUERY_PATTERN = /(token|secret|passwd|password|credential|bearer|signature|auth)/;

function isPrivateIPv4(ip: string): boolean {
  const [a, b] = ip.split(".").map((part) => Number(part));
  if (a === 0 || a === 10 || a === 127 || a === 255) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function stripIpv6Brackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function isPrivateIPv6(ip: string): boolean {
  const host = stripIpv6Brackets(ip).toLowerCase();
  if (host === "::" || host === "::1") return true;
  if (host.startsWith("fe80:")) return true;
  if (host.startsWith("fc") || host.startsWith("fd")) return true;
  if (host.startsWith("::ffff:")) {
    const mapped = host.slice("::ffff:".length);
    return isIP(mapped) === 4 ? isPrivateIPv4(mapped) : true;
  }
  return false;
}

function isProductionPubkyHost(hostname: string): boolean {
  return (
    hostname === "pubky.app" ||
    hostname.endsWith(".pubky.app") ||
    hostname === "nexus.pubky.app" ||
    hostname.endsWith(".nexus.pubky.app")
  );
}

/** Map lookalike letters so an IDN homograph of pubky.app still hits the suffix rule. */
function foldPubkyHomoglyphs(hostname: string): string {
  const map: Record<string, string> = {
    "\u0440": "p",
    "\u0420": "p",
    "\u03c1": "p",
    "\u03a1": "p",
    "\u0443": "y",
    "\u043a": "k",
    "\u03ba": "k",
    "\u0430": "a",
    "\u03b1": "a",
  };
  return [...hostname].map((ch) => map[ch] ?? ch).join("");
}

export function isBlockedCatalogHost(hostname: string): boolean {
  const host = stripIpv6Brackets(hostname.toLowerCase().replace(/\.+$/, ""));
  if (host === "localhost" || host.endsWith(".localhost") || host === "localhost.localdomain") return true;
  const kind = isIP(host);
  if (kind === 4) return isPrivateIPv4(host);
  if (kind === 6) return isPrivateIPv6(host);
  if (host.includes(":")) return true;
  return false;
}

function normalizeQueryKey(key: string): string {
  return key.trim().toLowerCase().replace(/[-.]/g, "_");
}

function isCredentialQueryKey(key: string): boolean {
  const normalized = normalizeQueryKey(key);
  if (!normalized) return false;
  if (QUERY_KEY_ALLOWLIST.has(normalized)) return false;
  if (CREDENTIAL_QUERY_TOKENS.has(normalized)) return true;
  const parts = normalized.split("_").filter(Boolean);
  if (parts.some((part) => CREDENTIAL_QUERY_TOKENS.has(part))) return true;
  return CREDENTIAL_QUERY_PATTERN.test(normalized);
}

export function hasCredentialQuery(url: URL): boolean {
  for (const key of url.searchParams.keys()) {
    if (isCredentialQueryKey(key)) return true;
  }
  return false;
}

/**
 * URL egress gates for any http(s) canonical value, regardless of family.
 * Returns a named reject reason or null.
 */
export function httpUrlRejectReason(
  value: string,
  originalRaw?: string,
  opts?: { treatAsUrl?: boolean },
): string | null {
  const trimmed = value.trim();
  const raw = originalRaw?.trim() || trimmed;
  const treatAsUrl = Boolean(opts?.treatAsUrl) || /^https?:/i.test(trimmed) || /^https?:/i.test(raw);
  if (!treatAsUrl) return null;
  let original: URL;
  try {
    original = new URL(raw);
  } catch {
    return "invalid URL";
  }
  if (original.username || original.password) return "URL credentials are not allowed";
  if (hasCredentialQuery(original)) return "URL credentials are not allowed";
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return "invalid URL";
  }
  if (url.protocol !== "https:") return "unsafe URL protocol";
  if (url.username || url.password) return "URL credentials are not allowed";
  if (hasCredentialQuery(url)) return "URL credentials are not allowed";
  const hostname = url.hostname.toLowerCase().replace(/\.+$/, "");
  let decodedHost = hostname;
  try {
    decodedHost = domainToUnicode(hostname).toLowerCase();
  } catch {
    decodedHost = hostname;
  }
  if (
    isProductionPubkyHost(hostname) ||
    isProductionPubkyHost(decodedHost) ||
    isProductionPubkyHost(foldPubkyHomoglyphs(decodedHost))
  ) {
    return "production target is not allowed";
  }
  if (isBlockedCatalogHost(url.hostname)) return "private or loopback host is not allowed";
  if (url.hostname.length < 3 || !url.hostname.includes(".")) return "low-value URL host";
  return null;
}
