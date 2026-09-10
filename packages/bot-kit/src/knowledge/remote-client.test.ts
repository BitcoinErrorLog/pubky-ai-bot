import { describe, expect, it, vi } from "vitest";
import { createRemoteKnowledgeClient, RemoteKnowledgeError, assertRemoteKnowledgeUrl } from "./remote-client.js";

const TOKEN = "t".repeat(32);
const payload = {
  audience: "public",
  chunks: [
    {
      title: "Intro",
      url: "https://pubky.org/docs/intro",
      source_id: "intro",
      corpus_version: "2026-09",
      snippet: "Public documentation.",
      ignored: "extra",
    },
  ],
  truncated: false,
  ignored: true,
};

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("remote knowledge client", () => {
  it("pins the configured host and strips extra response fields", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(response(200, payload));
    const client = createRemoteKnowledgeClient({ baseUrl: "http://jeb.railway.internal:8091", token: TOKEN });
    const result = await client.search("pubky", 2);
    expect(result).toEqual({
      audience: "public",
      chunks: [
        {
          title: "Intro",
          url: "https://pubky.org/docs/intro",
          source_id: "intro",
          corpus_version: "2026-09",
          snippet: "Public documentation.",
        },
      ],
      truncated: false,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("http://jeb.railway.internal:8091/internal/knowledge/retrieve"),
      expect.objectContaining({ redirect: "error" }),
    );
    fetchMock.mockRestore();
  });

  it("rejects a different host before making a request", () => {
    expect(() => assertRemoteKnowledgeUrl(new URL("http://other.internal/x"), "jeb.railway.internal")).toThrow(/ssrf/);
  });

  it("opens the breaker after repeated failures", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const client = createRemoteKnowledgeClient({ baseUrl: "http://jeb.railway.internal", token: TOKEN });
    for (let i = 0; i < 5; i++) await expect(client.search("pubky")).rejects.toBeInstanceOf(RemoteKnowledgeError);
    await expect(client.search("pubky")).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    fetchMock.mockRestore();
  });
});
