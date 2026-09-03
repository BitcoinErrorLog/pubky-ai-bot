import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const golden = JSON.parse(
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "schema.golden.json"), "utf8"),
) as unknown;

export interface StubRule {
  match?: (cypher: string, params: Record<string, unknown>) => boolean;
  status: number;
  body: unknown;
}

export function startScoutStub(rules: StubRule[]): Promise<{ url: string; server: Server; calls: string[] }> {
  const calls: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/v1/schema") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(golden));
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/query") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        calls.push(raw);
        let body: { cypher?: string; params?: Record<string, unknown> } = {};
        try {
          body = JSON.parse(raw) as { cypher?: string; params?: Record<string, unknown> };
        } catch {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "QUERY_SYNTAX_ERROR", message: "bad json" }));
          return;
        }
        const cypher = body.cypher ?? "";
        const params = body.params ?? {};
        const rule = rules.find((r) => !r.match || r.match(cypher, params));
        if (!rule) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ results: [], count: 0, truncated: false }));
          return;
        }
        res.writeHead(rule.status, { "content-type": "application/json" });
        res.end(typeof rule.body === "string" ? rule.body : JSON.stringify(rule.body));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, server, calls });
    });
  });
}
