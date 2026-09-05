import { Pubky } from "@synonymdev/pubky";

/**
 * Unauthenticated public homeserver GET. Uses Pubky `publicStorage` only.
 * This file never opens a session or writes.
 */
export type PublicReadResult = { status: number; body: unknown };

export type PublicHomeserverReader = {
  getJson(uri: string): Promise<PublicReadResult>;
};

function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return /404|not found|directory not found/i.test(err instanceof Error ? err.message : String(err));
  }
  const rec = err as { message?: unknown; data?: { statusCode?: unknown } };
  if (rec.data && typeof rec.data === "object" && rec.data.statusCode === 404) return true;
  const msg = typeof rec.message === "string" ? rec.message : String(err);
  return /404|not found|directory not found/i.test(msg);
}

export function createPublicHomeserverReader(opts?: { testnet?: boolean }): PublicHomeserverReader {
  const pubky = opts?.testnet ? Pubky.testnet() : new Pubky();
  return {
    async getJson(uri: string): Promise<PublicReadResult> {
      try {
        const body = await pubky.publicStorage.getJson(uri as never);
        return { status: 200, body };
      } catch (err) {
        if (isNotFound(err)) return { status: 404, body: null };
        throw err;
      }
    },
  };
}
