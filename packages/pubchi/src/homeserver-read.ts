import { Pubky } from "@synonymdev/pubky";

/**
 * Unauthenticated public homeserver GET. Uses Pubky `publicStorage` only.
 * This file never opens a session or writes.
 */
export type PublicReadResult = { status: number; body: unknown };

export type PublicHomeserverReader = {
  getJson(uri: string): Promise<PublicReadResult>;
};

export const HOMESERVER_READ_TIMEOUT_MS = 5_000;

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
}): PublicHomeserverReader {
  const pubky = opts?.testnet ? Pubky.testnet() : new Pubky();
  const timeoutMs = opts?.timeoutMs ?? HOMESERVER_READ_TIMEOUT_MS;
  return {
    async getJson(uri: string): Promise<PublicReadResult> {
      try {
        const body = await withTimeout(pubky.publicStorage.getJson(uri as never), timeoutMs);
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
