import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { readResponseBodyCapped } from "./bounded-body.js";

async function serve(
  handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

describe("readResponseBodyCapped", () => {
  it("rejects Content-Length over the cap without buffering the body", async () => {
    const s = await serve((_req, res) => {
      res.writeHead(200, { "content-length": "99999", "content-type": "text/plain" });
      res.end("tiny");
    });
    try {
      const res = await fetch(s.url);
      await expect(readResponseBodyCapped(res, 1024)).rejects.toThrow(/too large/);
    } finally {
      await s.close();
    }
  });

  it("aborts a streaming body once the cap is exceeded", async () => {
    const s = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("x".repeat(800));
      res.end("y".repeat(800));
    });
    try {
      const res = await fetch(s.url);
      await expect(readResponseBodyCapped(res, 1024)).rejects.toThrow(/too large/);
    } finally {
      await s.close();
    }
  });
});
