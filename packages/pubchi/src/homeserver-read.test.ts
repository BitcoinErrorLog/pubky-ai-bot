import type { PublicStorage } from "@synonymdev/pubky";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { buildPost, buildUri, buildUser, editPost, limits } from "pubky-social-specs";
import {
  createPublicHomeserverReader,
  HOMESERVER_READ_MAX_BYTES,
  wrapReaderTimeout,
  type PublicHomeserverReader,
} from "./homeserver-read.js";
import {
  botUri,
  configUri,
  ownerBindingUri,
  parsePubchiBotV1,
  parsePubchiConfigV1,
  parseOwnerBindingV1,
} from "@pubky/pubchi-schemas";

const noTargetRead = {
  list: async (): Promise<string[]> => { throw new Error("unexpected LIST"); },
  get: async (): Promise<Response> => { throw new Error("unexpected GET"); },
};

function fixture(name: string): string {
  return readFileSync(new URL(`./__fixtures__/homeserver/${name}.json`, import.meta.url), "utf8");
}

function replaceNullsWithUndefined(value: unknown): unknown {
  if (value === null) return undefined;
  if (Array.isArray(value)) return value.map(replaceNullsWithUndefined);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, replaceNullsWithUndefined(entry)]));
  }
  return value;
}

describe("homeserver public getJson timeout", () => {
  it("aborts a hung public getJson after the timeout", async () => {
    const hung: PublicHomeserverReader = {
      getJson: () => new Promise(() => {}),
    };
    const reader = wrapReaderTimeout(hung, 40);
    await expect(reader.getJson("pubky://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/pub/x.json")).rejects.toThrow(
      /homeserver_timeout/,
    );
  });
});

describe("homeserver public getJson wire fidelity", () => {
  it("parses the captured wire bodies with nulls preserved", async () => {
    const reader = createPublicHomeserverReader({
      publicStorage: {
        ...noTargetRead,
        getText: async (uri) => {
          if (uri.includes("/bots/")) return fixture("owner-binding");
          if (uri.endsWith("/config.json")) return fixture("config");
          return fixture("bot");
        },
      },
    });

    const bot = await reader.getJson(botUri("owner"));
    const config = await reader.getJson(configUri("owner"));
    const binding = await reader.getJson(ownerBindingUri("owner", "bot"));

    expect(bot.status).toBe(200);
    expect(config.status).toBe(200);
    expect(binding.status).toBe(200);
    expect(parsePubchiBotV1(bot.body).ok).toBe(true);
    expect(parsePubchiConfigV1(config.body).ok).toBe(true);
    expect(parseOwnerBindingV1(binding.body).ok).toBe(true);
    expect((bot.body as { backup_confirmed_at: unknown }).backup_confirmed_at).toBeNull();
    expect((config.body as { brain: { endpoint: unknown } }).brain.endpoint).toBeNull();
  });

  it("documents the old SDK conversion failure for null fields", () => {
    const bot = replaceNullsWithUndefined(JSON.parse(fixture("bot")));
    const config = replaceNullsWithUndefined(JSON.parse(fixture("config")));

    expect(parsePubchiBotV1(bot)).toEqual({ ok: false, code: "SCHEMA_INVALID" });
    expect(parsePubchiConfigV1(config)).toEqual({ ok: false, code: "BRAIN_FORBIDDEN" });
  });

  it("rejects oversized, malformed, and non-object bodies with typed failures", async () => {
    const reader = (text: string) => createPublicHomeserverReader({
      publicStorage: { ...noTargetRead, getText: async () => text },
    }).getJson("pubky://owner/pub/document.json");

    await expect(reader("x".repeat(HOMESERVER_READ_MAX_BYTES + 1))).rejects.toMatchObject({
      code: "homeserver_body_too_large",
    });
    const capped = createPublicHomeserverReader({
      publicStorage: { ...noTargetRead, getText: async () => JSON.stringify({ body: "1234567890" }) },
    });
    await expect(capped.getJson("pubky://owner/pub/document.json", 10)).rejects.toMatchObject({
      code: "homeserver_body_too_large",
    });
    await expect(reader("{")).rejects.toMatchObject({ code: "homeserver_invalid_json" });
    await expect(reader("[]")).rejects.toMatchObject({ code: "homeserver_non_object" });
  });
});

describe("authoritative public target snapshots", () => {
  const owner = "n9fzu63meroxfcxccz1budmqbn3e7yj97cy6jjyyoqpamacyod8y";
  const other = "93cmekqb6dgpq1up5rkhmcgfacdskxmefn3qxp9fswcwagz3bt1o";
  const missing = Object.assign(new Error("request failed"), { data: { statusCode: 404 } });
  const noJson = async (): Promise<string> => { throw new Error("unexpected text read"); };

  it("uses the latest canonical public edit across pages and preserves the stored article envelope", async () => {
    const first = buildPost(owner, { content: "First version" });
    const article = buildPost(owner, { kind: "article", title: "An article", body: "Revised Ω" });
    const latest = editPost(owner, first.url, article.object, { slug: "current" });
    const foreign = editPost(owner, latest.url, { ...latest.object }, { slug: "foreign" });
    const uri = buildUri(owner, "post", first.id);
    const list = vi.fn<PublicStorage["list"]>();
    list.mockImplementationOnce(async () => [
      ...Array.from({ length: 99 }, (_, i) => `${uri}/${String(i).padStart(13, "0")}.txt`), first.url,
    ]).mockResolvedValueOnce([
      latest.url, foreign.url.replace(owner, other), foreign.url.replace("/pub/", "/priv/"), `${uri}/unexpected/${latest.editId}.json`,
    ]);
    const get = vi.fn<PublicStorage["get"]>(async () => new Response(latest.body));
    const reader = createPublicHomeserverReader({ publicStorage: { list, get, getText: noJson } });
    const snapshot = await reader.readPublicTargetSnapshot({ kind: "post", uri });
    expect(snapshot).toEqual({ kind: "post", content: article.object.content, postKind: "article" });
    expect(list.mock.calls).toEqual([[`${uri}/`, null, false, 100, false], [`${uri}/`, first.url, false, 100, false]]);
    expect(get.mock.calls).toEqual([[latest.url]]);
  });

  it("reads only the requested v1 profile and retains its nullable bio", async () => {
    const profile = buildUser(owner, { name: "Alice" });
    const get = vi.fn<PublicStorage["get"]>(async () => new Response(profile.body));
    const reader = createPublicHomeserverReader({ publicStorage: { ...noTargetRead, get, getText: noJson } });
    await expect(reader.readPublicTargetSnapshot({ kind: "user", uri: profile.url }))
      .resolves.toEqual({ kind: "user", name: profile.object.name, bio: null });
    expect(get.mock.calls).toEqual([[profile.url]]);
  });

  it("returns null for a missing current version or profile, and rejects malformed data and transport failures", async () => {
    const initial = buildPost(owner, { content: "Post" });
    const post = { kind: "post" as const, uri: buildUri(owner, "post", initial.id) };
    const user = { kind: "user" as const, uri: buildUri(owner, "user") };
    const list = vi.fn(async () => [initial.url]);
    const get = vi.fn<PublicStorage["get"]>(async () => new Response(initial.body));
    const reader = createPublicHomeserverReader({ publicStorage: { list, get, getText: noJson } });
    list.mockRejectedValueOnce(missing).mockResolvedValueOnce([`${post.uri}/README`]);
    await expect(reader.readPublicTargetSnapshot(post)).resolves.toBeNull();
    await expect(reader.readPublicTargetSnapshot(post)).resolves.toBeNull();
    expect(get).not.toHaveBeenCalled();
    get.mockRejectedValueOnce(missing).mockRejectedValueOnce(missing);
    await expect(reader.readPublicTargetSnapshot(post)).resolves.toBeNull();
    await expect(reader.readPublicTargetSnapshot(user)).resolves.toBeNull();

    get.mockResolvedValueOnce(new Response("{}")).mockResolvedValueOnce(new Response(new Uint8Array(limits.postMaxBytes + 1)));
    await expect(reader.readPublicTargetSnapshot(post)).rejects.toThrow();
    await expect(reader.readPublicTargetSnapshot(post)).rejects.toThrow("too large");
    list.mockRejectedValueOnce(new Error("relay not found"));
    await expect(reader.readPublicTargetSnapshot(post)).rejects.toThrow("relay not found");
    get.mockResolvedValueOnce(new Response("{}"));
    await expect(reader.readPublicTargetSnapshot(user)).rejects.toThrow();
  });

  it("cancels oversized streamed bodies and enforces the overall deadline on stalled streams", async () => {
    const user = { kind: "user" as const, uri: buildUri(owner, "user") };
    const cancel = vi.fn();
    const oversized = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new Uint8Array(limits.objectMaxBytes));
        stream.enqueue(new Uint8Array(1));
      },
      cancel,
    });
    const get = vi.fn<PublicStorage["get"]>()
      .mockResolvedValueOnce(new Response(oversized, { headers: { "content-length": "1" } }))
      .mockResolvedValueOnce(new Response(new ReadableStream({ cancel })))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    const reader = createPublicHomeserverReader({ timeoutMs: 30, publicStorage: { ...noTargetRead, get, getText: noJson } });
    await expect(reader.readPublicTargetSnapshot(user)).rejects.toThrow("too large");
    await expect(reader.readPublicTargetSnapshot(user)).rejects.toThrow("homeserver_timeout");
    expect(cancel).toHaveBeenCalledTimes(2);
    await expect(reader.readPublicTargetSnapshot(user)).resolves.toBeNull();
    await expect(reader.readPublicTargetSnapshot(user)).rejects.toThrow("homeserver_snapshot_http_503");
  });

  it("cancels the unread response if GET returns after the deadline", async () => {
    const profile = buildUser(owner, { name: "Alice" });
    const cancel = vi.fn();
    let deliver!: (response: Response) => void;
    const get = () => new Promise<Response>((resolve) => { deliver = resolve; });
    const reader = createPublicHomeserverReader({ timeoutMs: 20, publicStorage: { ...noTargetRead, get, getText: noJson } });
    await expect(reader.readPublicTargetSnapshot({ kind: "user", uri: profile.url })).rejects.toThrow("homeserver_timeout");
    deliver(new Response(new ReadableStream({ cancel })));
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
  });

  it("refuses private, legacy and version-file targets before making a read", async () => {
    const first = buildPost(owner, { content: "Private input" });
    const ref = buildUri(owner, "post", first.id);
    const list = vi.fn(), get = vi.fn();
    const reader = createPublicHomeserverReader({ publicStorage: { list, get, getText: noJson } });
    for (const uri of [ref.replace("/pub/", "/priv/"), first.url, ref.replace("social/v1", "pubky.app")]) {
      await expect(reader.readPublicTargetSnapshot({ kind: "post", uri })).rejects.toThrow("invalid_public_target");
    }
    expect(list).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it("bounds a stalled listing and stops if pagination cannot advance", async () => {
    const post = { kind: "post" as const, uri: buildUri(owner, "post", "00321FCW75ZFY") };
    const list = vi.fn(() => new Promise<string[]>(() => {}));
    const reader = createPublicHomeserverReader({ timeoutMs: 30, publicStorage: { list, get: noTargetRead.get, getText: noJson } });
    await expect(reader.readPublicTargetSnapshot(post)).rejects.toThrow("homeserver_timeout");
    list.mockResolvedValue(Array.from({ length: 100 }, () => `${post.uri}/junk`));
    await expect(reader.readPublicTargetSnapshot(post)).rejects.toThrow("homeserver_invalid_cursor");
  });
});
