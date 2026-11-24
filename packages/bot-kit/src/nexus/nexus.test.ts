import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildUri } from "pubky-social-specs";
import { readFileSync } from "node:fs";
import { influencersSchema } from "../nexus-schema.js";
import { Nexus } from "./nexus.js";
import { nexusTools } from "./tools.js";

const fixture = influencersSchema.parse(
  JSON.parse(readFileSync(new URL("./influencers.fixture.json", import.meta.url), "utf8")),
);

describe("Nexus influencers", () => {
  it("parses the captured stream/users response shape", async () => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.url ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(fixture));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture did not bind");
    try {
      const out = await new Nexus(`http://127.0.0.1:${address.port}`, 1_000).influencers(5, "all_time");
      expect(out).toEqual(fixture);
      expect(requests).toEqual(["/v0/stream/users?source=influencers&limit=5&timeframe=all_time"]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("maps Nexus HTTP failures to a rejected upstream call", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(503);
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture did not bind");
    try {
      await expect(new Nexus(`http://127.0.0.1:${address.port}`).influencers(5)).rejects.toThrow("influencers 503");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});

describe("Pubchi Nexus v1", () => {
  const owner = "n9fzu63meroxfcxccz1budmqbn3e7yj97cy6jjyyoqpamacyod8y";
  const id = "00321FCW75ZFY";
  const parentId = "0032W6CBGDBP0";
  const post = buildUri(owner, "post", id);
  const parent = buildUri(owner, "post", parentId);
  const stored = `pubky://${owner}/pub/pubky.app/posts/${id}`;
  const view = {
    details: { author: owner, id, content: "Entry", kind: "note", uri: stored, indexed_at: 1, deleted: false },
    relationships: { replied: `pubky://${owner}/pub/pubky.app/posts/${parentId}` },
  };
  const nexus = new Nexus("https://nexus.example", 5_000, "v1");

  afterEach(() => vi.restoreAllMocks());

  it("reads and walks current public post references across migrated and unmigrated authors", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === `/v1/post/${owner}/${id}`) return Response.json(view);
      if (path === `/v1/post/${owner}/${parentId}`) {
        return Response.json({ details: { ...view.details, id: parentId, uri: `${parent}/${parentId}.json`, kind: "article" } });
      }
      if (path === "/v1/stream/posts") return Response.json([view]);
      throw new Error(`unexpected request ${path}`);
    });
    const tools = nexusTools(nexus);
    expect(await tools.get_post.execute({ uri: post })).toMatchObject({
      post: { details: { uri: post, content: "Entry", kind: "note" }, relationships: { replied: parent } },
    });
    expect(await tools.get_thread.execute({ uri: post })).toMatchObject({ posts: [post, parent] });
    expect(await tools.get_post_replies.execute({ uri: post, limit: 2 })).toMatchObject({
      replies: [{ details: { uri: post } }],
    });
    expect(String(fetch.mock.lastCall?.[0])).toBe(
      `https://nexus.example/v1/stream/posts?source=post_replies&author_id=${owner}&post_id=${id}&limit=2`,
    );
    await expect(nexus.streamPosts({ limit: 1 })).resolves.toMatchObject([{ details: { uri: post } }]);
    fetch.mockClear();
    for (const invalid of [stored, post.replace("/pub/", "/priv/"), `${post}/${id}.json`]) {
      await expect(nexus.post(invalid)).resolves.toBeNull();
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("drops a tombstone, a private reply and responses for a different post or profile", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    for (const details of [
      { ...view.details, deleted: true },
      { ...view.details, uri: post.replace("/pub/", "/priv/") },
      { ...view.details, uri: parent },
      { ...view.details, id: parentId, uri: parent },
    ]) {
      fetch.mockResolvedValueOnce(Response.json({ details }));
      await expect(nexus.post(post)).resolves.toBeNull();
    }
    for (const details of [{ id: owner, name: "", deleted: true }, { id: "another-user", name: "Jane" }]) {
      fetch.mockResolvedValueOnce(Response.json(details));
      await expect(nexus.userDetails(owner)).resolves.toBeNull();
    }
  });

  it("reads v1 user tags, notification evidence and search results", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const rawTag = { label: "Ärger", taggers: [owner], taggers_count: 1 };
    const tagUri = buildUri(owner, "tag", "FPB0AM9S93Q3M1GFY1KV09GMQM");
    fetch.mockResolvedValueOnce(Response.json([{ ...rawTag, tag_uri: null }, { ...rawTag, tag_uri: tagUri }]));
    await expect(nexus.userTags(owner)).resolves.toEqual([
      { ...rawTag, relationship: false }, { ...rawTag, relationship: true },
    ]);
    fetch.mockResolvedValueOnce(Response.json([{ timestamp: 1, body: { type: "mention", post_uri: stored } }]));
    await expect(nexus.notifications(owner, null, 1)).resolves.toMatchObject([{ body: { post_uri: post } }]);
    fetch.mockResolvedValueOnce(Response.json([{ label: "Ärger" }]));
    await expect(nexus.searchTags("Är", 2)).resolves.toEqual(["Ärger"]);
    fetch.mockResolvedValueOnce(Response.json([{ post_key: `${owner}:${id}`, score: 1 }, { post_key: "invalid", score: 2 }]));
    await expect(nexusTools(nexus).search_posts_by_tag.execute({ tag: "Ärger", limit: 3 })).resolves.toMatchObject({
      posts: [{ post_key: `${owner}:${id}`, score: 1, uri: post }],
    });
    expect(fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      `/v1/user/${owner}/tags`, `/v1/user/${owner}/notifications`, "/v1/search/tags/by_prefix/%C3%84r",
      "/v1/search/posts/by_tag/%C3%84rger",
    ]);
  });
});
