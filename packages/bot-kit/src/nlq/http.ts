import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { schemaHealthSnapshot } from "../scout/schema-cache.js";
import { queryNlq, type NlqServiceOptions } from "./service.js";
import { nlqResult, type NlqRequest } from "./types.js";

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export type NlqListenOptions = NlqServiceOptions & {
  port?: number;
  bind?: string;
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function nlqBind(bind?: string): string {
  const raw = bind?.trim();
  return raw && raw.length > 0 ? raw : "127.0.0.1";
}

export function isLoopbackBind(bind: string): boolean {
  return LOOPBACK.has(bind);
}

export function listenNlq(opts: NlqListenOptions): Promise<{ server: Server; url: string; bind: string; port: number }> {
  const bind = nlqBind(opts.bind);
  const port = opts.port ?? 0;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${bind}`);
      if (req.method === "GET" && url.pathname === "/healthz") {
        writeJson(res, 200, { ok: true, role: "nlq", scoutSchema: schemaHealthSnapshot() });
        return;
      }
      if (req.method === "POST" && (url.pathname === "/v1/query" || url.pathname === "/query")) {
        let raw: string;
        try {
          raw = await readBody(req);
        } catch {
          writeJson(
            res,
            400,
            nlqResult({ outcome: "unsupported", reason: "request body too large or unreadable", intent: "ignore" }),
          );
          return;
        }
        let body: NlqRequest;
        try {
          body = JSON.parse(raw || "{}") as NlqRequest;
        } catch {
          writeJson(res, 400, nlqResult({ outcome: "unsupported", reason: "invalid JSON", intent: "ignore" }));
          return;
        }
        if (typeof body.question !== "string") {
          writeJson(res, 400, nlqResult({ outcome: "unsupported", reason: "question is required", intent: "ignore" }));
          return;
        }
        const result = await queryNlq(body, opts);
        writeJson(res, 200, result);
        return;
      }
      writeJson(res, 404, nlqResult({ outcome: "unsupported", reason: "not found", intent: "ignore" }));
    } catch (e) {
      writeJson(
        res,
        200,
        nlqResult({
          outcome: "tool_error",
          reason: e instanceof Error ? e.message : "internal error",
          intent: "answer",
        }),
      );
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, bind, () => {
      const addr = server.address() as AddressInfo;
      resolve({
        server,
        bind,
        port: addr.port,
        url: `http://${bind === "::1" ? "[::1]" : bind}:${addr.port}`,
      });
    });
  });
}
