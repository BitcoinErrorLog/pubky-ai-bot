import { Pubky, type PublicStorage } from "@synonymdev/pubky";

/**
 * Unauthenticated public homeserver GET. Reads raw text through Pubky
 * `publicStorage`, then parses it here so wire `null` values are preserved.
 * This file never opens a session or writes.
 */
export type PublicReadResult = { status: number; body: unknown };

export type PublicHomeserverReader = {
  getJson(uri: string): Promise<PublicReadResult>;
};

export const HOMESERVER_READ_TIMEOUT_MS = 5_000;
export const HOMESERVER_READ_MAX_BYTES = 256 * 1024;

export class HomeserverReadError extends Error {
  constructor(
    readonly code: "homeserver_body_too_large" | "homeserver_invalid_json" | "homeserver_non_object",
  ) {
    super(code);
    this.name = "HomeserverReadError";
  }
}

function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return /404|not found|directory not found/i.test(err instanceof Error ? err.message : String(err));
  }
  const rec = err as { message?: unknown; data?: { statusCode?: unknown } };
  if (rec.data && typeof rec.data === "object" && rec.data.statusCode === 404) return true;
  const msg = typeof rec.message === "string" ? rec.message : String(err);
  return /404|not found|directory not found/i.test(msg);
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("homeserver_timeout")), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export function createPublicHomeserverReader(opts?: {
  testnet?: boolean;
  timeoutMs?: number;
  publicStorage?: Pick<PublicStorage, "getText">;
}): PublicHomeserverReader {
  const pubky = opts?.testnet ? Pubky.testnet() : new Pubky();
  const timeoutMs = opts?.timeoutMs ?? HOMESERVER_READ_TIMEOUT_MS;
  const publicStorage = opts?.publicStorage ?? pubky.publicStorage;
  return {
    async getJson(uri: string): Promise<PublicReadResult> {
      try {
        const text = await withTimeout(publicStorage.getText(uri as never), timeoutMs);
        if (new TextEncoder().encode(text).byteLength > HOMESERVER_READ_MAX_BYTES) {
          throw new HomeserverReadError("homeserver_body_too_large");
        }
        let body: unknown;
        try {
          body = JSON.parse(text) as unknown;
        } catch {
          throw new HomeserverReadError("homeserver_invalid_json");
        }
        if (body === null || typeof body !== "object" || Array.isArray(body)) {
          throw new HomeserverReadError("homeserver_non_object");
        }
        return { status: 200, body };
      } catch (err) {
        if (isNotFound(err)) return { status: 404, body: null };
        throw err;
      }
    },
  };
}

export function wrapReaderTimeout(reader: PublicHomeserverReader, timeoutMs = HOMESERVER_READ_TIMEOUT_MS): PublicHomeserverReader {
  return {
    getJson(uri) {
      return withTimeout(reader.getJson(uri), timeoutMs);
    },
  };
}
