import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const golden = JSON.parse(
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../scout/schema.golden.json"), "utf8"),
) as unknown;

export interface NlqStubRule {
  match?: (cypher: string, params: Record<string, unknown>) => boolean;
  status: number;
  body: unknown;
}

export function startNlqScoutStub(opts?: {
  schema?: unknown | "fail";
  rules?: NlqStubRule[];
}): Promise<{ url: string; server: Server; calls: string[]; schemaGets: number }> {
  const calls: string[] = [];
  let schemaGets = 0;
  const rules = opts?.rules ?? [];
  const schema = opts?.schema ?? golden;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/v1/schema") {
      schemaGets += 1;
      if (schema === "fail") {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "UNAVAILABLE", message: "schema down" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(schema));
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
      resolve({ url: `http://127.0.0.1:${port}`, server, calls, get schemaGets() { return schemaGets; } });
    });
  });
}

export function goldenWithoutRel(type: string): unknown {
  const copy = JSON.parse(JSON.stringify(golden)) as {
    relationships: Array<{ type: string }>;
  };
  copy.relationships = copy.relationships.filter((r) => r.type !== type);
  return copy;
}

export function identitySummaryRules(user: string, other: string): NlqStubRule[] {
  return [
    {
      match: (c) => c.includes("count(p)"),
      status: 200,
      body: { results: [{ id: user, name: "Ada", posts: 3 }], count: 1, truncated: false },
    },
    {
      match: (c) => c.includes("followers"),
      status: 200,
      body: { results: [{ followers: 9 }], count: 1, truncated: false },
    },
    {
      match: (c) => c.includes("following"),
      status: 200,
      body: { results: [{ following: 4 }], count: 1, truncated: false },
    },
    {
      match: (c) => c.includes("self_claim"),
      status: 200,
      body: {
        results: [{ label: "builder", count: 5, claimant_ids: [other], self_claim: false }],
        count: 1,
        truncated: false,
      },
    },
  ];
}
