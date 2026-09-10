import { Pubky } from "@synonymdev/pubky";
import { listOwnedJsonPaths, type Transport } from "./homeserver.js";

/**
 * Keyless read-only transport for the planner.
 *
 * Homeserver public paths are readable without any session, so a reconcile
 * planner can snapshot Jeb's tag prefix without ever holding the bot key.
 * Public readability authorizes nothing: every write operation here throws,
 * and the executor still has to mint the scoped session before it mutates.
 * The same ownership, pagination, and prefix rules as the session listing
 * are enforced through the shared `listOwnedJsonPaths`.
 */
export function publicTagReadTransport(opts: {
  publisherPk: string;
  testnet?: boolean;
  /** Test seams; production uses the SDK public storage. */
  list?: (address: string, cursor: string | null, limit: number) => Promise<string[]>;
  getJson?: (uri: string) => Promise<unknown>;
}): Transport {
  const pubky = opts.testnet ? Pubky.testnet() : new Pubky();
  const origin = `pubky://${opts.publisherPk}`;
  const list =
    opts.list ??
    ((address: string, cursor: string | null, limit: number) =>
      pubky.publicStorage.list(address as never, cursor, false, limit, false) as Promise<string[]>);
  const getJson =
    opts.getJson ?? ((uri: string) => pubky.publicStorage.getJson(uri as never) as Promise<unknown>);
  return {
    botPk: opts.publisherPk,
    async putJson(): Promise<void> {
      throw new Error("public read transport cannot write");
    },
    async putBytes(): Promise<void> {
      throw new Error("public read transport cannot write");
    },
    async getJson(path: string): Promise<unknown> {
      return getJson(`${origin}${path}`);
    },
    async deleteJson(): Promise<void> {
      throw new Error("public read transport cannot write");
    },
    async listJsonPaths(prefix: string): Promise<string[]> {
      return listOwnedJsonPaths(
        (listPath, cursor, limit) => list(`${opts.publisherPk}${listPath}`, cursor, limit),
        opts.publisherPk,
        prefix,
      );
    },
    async listPosts(): Promise<Array<{ parent?: string; uri: string }>> {
      throw new Error("public read transport does not list posts");
    },
    async reauth(): Promise<void> {},
  };
}
