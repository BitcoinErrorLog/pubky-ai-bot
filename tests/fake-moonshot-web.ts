import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type MoonshotScript =
  | { status: number; body: unknown }
  | ((n: number, body: Record<string, unknown>) => { status: number; body: unknown });

/** Test-only OpenAI-compatible stub that scripts chat.completions turns. */
export function startFakeMoonshotWeb(script: MoonshotScript[]): Promise<{
  url: string;
  server: Server;
  bodies: Record<string, unknown>[];
}> {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(404);
      res.end();
      return;
    }
    let raw = "";
    req.on("data", (chunk) => {
      raw += String(chunk);
    });
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        body = {};
      }
      bodies.push(body);
      const step = script[bodies.length - 1];
      const out =
        typeof step === "function"
          ? step(bodies.length, body)
          : step ?? { status: 500, body: { error: "no script" } };
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(JSON.stringify(out.body));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${addr.port}/v1`, server, bodies });
    });
  });
}

export function moonshotToolTurn(args = '{"query":"bitcoin news"}'): { status: number; body: unknown } {
  return {
    status: 200,
    body: {
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            reasoning_content: "need live results",
            tool_calls: [
              {
                id: "call_web_1",
                type: "function",
                function: { name: "$web_search", arguments: args },
              },
            ],
          },
        },
      ],
    },
  };
}

export function moonshotFinalTurn(opts?: { content?: string; annotations?: unknown }): { status: number; body: unknown } {
  return {
    status: 200,
    body: {
      choices: [
        {
          finish_reason: "stop",
          message: {
            role: "assistant",
            content:
              opts?.content ??
              "Reports cite https://example.com/a as support. See also https://news.example/b.",
            annotations:
              opts?.annotations ??
              [
                {
                  type: "url_citation",
                  url_citation: { url: "https://example.com/a", title: "Example A" },
                },
              ],
            citations: [{ url: "https://news.example/b", title: "News B" }],
          },
        },
      ],
    },
  };
}
