import { Pubky, type Address, type PublicStorage } from "@synonymdev/pubky";
import { decodeObject, limits, parseUri, ValidationError } from "pubky-social-specs";
import { readResponseBodyCapped } from "../bot-kit/knowledge/bounded-body.js";
import { parsePubchiTarget, type AskTarget } from "../pubchi-schemas/index.js";

export type PublicTargetSnapshot =
  | { kind: "post"; content: string; postKind: string }
  | { kind: "user"; name: string; bio: string | null };

type ReadPublicTargetSnapshot = (target: AskTarget) => Promise<PublicTargetSnapshot | null>;
type PublicSnapshotStorage = Pick<PublicStorage, "list" | "get">;

/**
 * Unauthenticated public homeserver GET. Reads raw text through Pubky
 * `publicStorage`, then parses it here so wire `null` values are preserved.
 * This file never opens a session or writes.
 */
export type PublicReadResult = { status: number; body: unknown };

export type PublicHomeserverReader = {
  getJson(uri: string, maxBytes?: number): Promise<PublicReadResult>;
  readPublicTargetSnapshot?: ReadPublicTargetSnapshot;
};

export const HOMESERVER_READ_TIMEOUT_MS = 5_000;
export const HOMESERVER_READ_MAX_BYTES = 64 * 1024;

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

// Only the latest edit id matters. Keep the same first-on-ties rule as the App's pickHeadVersion.
const VERSION_PAGE_SIZE = 100;

async function latestPublicPostVersion(
  storage: PublicSnapshotStorage, reference: string, read: <T>(operation: () => Promise<T>) => Promise<T>,
): Promise<string | null> {
  const directory = `${reference}/`;
  let cursor: string | null = null;
  let head: { url: string; editId: string } | null = null;
  for (;;) {
    const page = await read(() => storage.list(directory as Address, cursor, false, VERSION_PAGE_SIZE, false));
    for (const url of page) {
      if (!url.startsWith(directory)) continue;
      try {
        const version = parseUri(url);
        if (version.kind === "post" && version.root === "public" && version.editId &&
            (!head || version.editId > head.editId)) {
          head = { url, editId: version.editId };
        }
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
      }
    }
    if (page.length < VERSION_PAGE_SIZE) return head?.url ?? null;
    const next = page[page.length - 1];
    if (!next.startsWith(directory) || (cursor !== null && next <= cursor)) {
      throw new Error("homeserver_invalid_cursor");
    }
    cursor = next;
  }
}

async function readPublicTargetSnapshot(
  storage: PublicSnapshotStorage, target: AskTarget, timeoutMs: number,
): Promise<PublicTargetSnapshot | null> {
  const parsed = parsePubchiTarget(target);
  if (!parsed) throw new Error("invalid_public_target");
  const deadline = performance.now() + timeoutMs;
  const controller = new AbortController();
  const read = <T>(operation: () => Promise<T>): Promise<T> => {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error("homeserver_timeout");
    return withTimeout(operation(), remaining);
  };

  try {
    const uri = parsed.kind === "post" ? await latestPublicPostVersion(storage, target.uri, read) : target.uri;
    if (!uri) return null;
    const response = await read(async () => {
      const response = await storage.get(uri as Address);
      // The SDK has no signal for the GET itself. Cancel a stream whose headers arrived after our deadline.
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => undefined);
        controller.signal.throwIfAborted();
      }
      return response;
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      if (response.status === 404) return null;
      throw new Error(`homeserver_snapshot_http_${response.status}`);
    }
    const max = parsed.kind === "post" ? limits.postMaxBytes : limits.objectMaxBytes;
    const bytes = await read(() => readResponseBodyCapped(response, max, controller.signal));
    if (parsed.kind === "post") {
      const post = decodeObject(uri, bytes, "post");
      return { kind: "post", content: post.content, postKind: post.kind };
    }
    const user = decodeObject(uri, bytes, "user");
    return { kind: "user", name: user.name, bio: user.bio };
  } catch (error) {
    // The SDK reports a missing file/directory as an HTTP 404. Transport and decoding failures are distinct.
    if (typeof error === "object" && error !== null && "data" in error &&
        (error.data as { statusCode?: number } | null)?.statusCode === 404) return null;
    throw error;
  } finally {
    controller.abort();
  }
}

export function createPublicHomeserverReader(opts?: {
  testnet?: boolean;
  timeoutMs?: number;
  publicStorage?: Pick<PublicStorage, "getText"> & PublicSnapshotStorage;
}): PublicHomeserverReader & { readPublicTargetSnapshot: ReadPublicTargetSnapshot } {
  const timeoutMs = opts?.timeoutMs ?? HOMESERVER_READ_TIMEOUT_MS;
  const publicStorage = opts?.publicStorage ?? (opts?.testnet ? Pubky.testnet() : new Pubky()).publicStorage;
  return {
    readPublicTargetSnapshot: (target) => readPublicTargetSnapshot(publicStorage, target, timeoutMs),
    async getJson(uri: string, maxBytes = HOMESERVER_READ_MAX_BYTES): Promise<PublicReadResult> {
      try {
        const text = await withTimeout(publicStorage.getText(uri as never), timeoutMs);
        if (new TextEncoder().encode(text).byteLength > maxBytes) {
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
    ...(reader.readPublicTargetSnapshot && {
      readPublicTargetSnapshot: (target: AskTarget) => withTimeout(reader.readPublicTargetSnapshot!(target), timeoutMs),
    }),
    getJson(uri, maxBytes) {
      return withTimeout(reader.getJson(uri, maxBytes), timeoutMs);
    },
  };
}
