import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { influencersSchema } from "../nexus-schema.js";
import { Nexus } from "./nexus.js";

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
