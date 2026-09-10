import { describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { createKnowledgeHandler, publicKnowledgePayload, type KnowledgeRetrievalOptions } from "./http.js";

const TOKEN = "r".repeat(32);
const chunk = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  content: "Public Pubky documentation.",
  source_url: "https://pubky.org/docs/intro.md",
  source_id: "docs-intro",
  product: "pubky",
  component: "docs",
  status: "canonical" as const,
  version: "2026-09",
  score: 1,
  ...overrides,
});

function listen(retrieve: KnowledgeRetrievalOptions["retrieve"], now?: () => number) {
  const server = createServer(
    createKnowledgeHandler({
      pool: {} as never,
      token: TOKEN,
      privateHost: "127.0.0.1",
      retrieve,
      now,
    }),
  );
  return new Promise<{ server: ReturnType<typeof createServer>; url: string }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("not listening");
      resolve({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${url}/internal/knowledge/retrieve`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("internal knowledge retrieval", () => {
  it("requires the private host and constant-time bearer token", async () => {
    const { server, url } = await listen(async () => ({ chunks: [chunk()], truncated: false }));
    await expect((await post(url, { query: "pubky" }, { authorization: "" })).status).toBe(401);
    await expect((await post(url, { query: "pubky" }, { authorization: "Bearer wrong" })).status).toBe(401);
    await expect((await post(url, { query: "pubky" })).status).toBe(200);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("rate-limits a caller at ten requests per second", async () => {
    const { server, url } = await listen(async () => ({ chunks: [chunk()], truncated: false }), () => 1_000);
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await post(url, { query: "pubky" })).status);
    expect(statuses.slice(0, 10).every((status) => status === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("rejects extra request fields and clamps k", async () => {
    const retrieve = vi.fn(async (_query: string, k: number) => ({ chunks: [chunk()], truncated: false }));
    const { server, url } = await listen(retrieve);
    expect((await post(url, { query: "pubky", extra: true })).status).toBe(400);
    expect((await post(url, { query: "pubky", k: 7 })).status).toBe(400);
    expect((await post(url, { query: "pubky", k: 6 })).status).toBe(200);
    expect(retrieve).toHaveBeenCalledWith("pubky", 6);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("enforces public sources, HTTPS, one source, and the byte cap", () => {
    const payload = publicKnowledgePayload({
      chunks: [
        chunk({ source_id: "private", status: "opinion" }),
        chunk({ source_id: "http", source_url: "http://pubky.org/docs/http.md" }),
        chunk({ source_id: "docs-intro", content: "a".repeat(250) }),
        chunk({ source_id: "second", source_url: "https://pubky.org/docs/second.md" }),
      ],
      truncated: false,
    });
    expect(payload.audience).toBe("public");
    expect(payload.chunks.map((item) => item.source_id)).toEqual(["docs-intro", "second"]);
    expect(payload.chunks.every((item) => item.snippet.length <= 240)).toBe(true);
  });

  it("returns upstream unavailable on the server deadline", async () => {
    const { server, url } = await listen(() => new Promise(() => undefined));
    const response = await post(url, { query: "pubky" });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "UPSTREAM_UNAVAILABLE" });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }, 4_000);
});
