import { isIP } from "node:net";
import { log } from "../log.js";

export const MOONSHOT_HOST = "api.moonshot.ai";
export const MOONSHOT_BASE_URL = "https://api.moonshot.ai/v1";
export const OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export class BrainEgressError extends Error {
  readonly host: string;
  constructor(host: string) {
    super(
      `brain egress refused: host '${host}' is not api.moonshot.ai or loopback; set JEB_BRAIN_EGRESS_DANGEROUS=1 to override`,
    );
    this.name = "BrainEgressError";
    this.host = host;
  }
}

export function hostnameFromBaseUrl(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`invalid brain base URL: ${baseUrl}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`invalid brain base URL protocol: ${parsed.protocol}`);
  }
  return parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

export function isLoopbackHost(host: string): boolean {
  if (LOOPBACK_HOSTS.has(host)) return true;
  const ip = isIP(host);
  if (ip === 4) return host.startsWith("127.");
  if (ip === 6) return host === "::1";
  return false;
}

export function isAllowedBrainHost(host: string): boolean {
  return host === MOONSHOT_HOST || isLoopbackHost(host);
}

export function assertBrainEgressAllowed(
  baseUrl: string,
  opts?: { dangerous?: boolean },
): void {
  const host = hostnameFromBaseUrl(baseUrl);
  if (isAllowedBrainHost(host)) return;
  if (opts?.dangerous) {
    log.warn(
      { event: "brain_egress_dangerous", host },
      "brain base URL host is not allowlisted; JEB_BRAIN_EGRESS_DANGEROUS=1 is set",
    );
    return;
  }
  throw new BrainEgressError(host);
}
