import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export type FakeOpenAIHandler = (
  call: number,
  body: Record<string, unknown>,
) =>
  | { status?: number; delayMs?: number; json: Record<string, unknown> }
  | { hang: true; delayMs?: number };

export function completionJson(content: string, extras?: { toolCalls?: unknown[] }): Record<string, unknown> {
  const message: Record<string, unknown> = {
    role: "assistant",
    content: extras?.toolCalls ? null : content,
  };
  if (extras?.toolCalls) message.tool_calls = extras.toolCalls;
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    choices: [
      {
        index: 0,
        message,
        finish_reason: extras?.toolCalls ? "tool_calls" : "stop",
      },
    ],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  };
}

/** Test-only OpenAI-compatible stub. Never import from src/. */
export function startFakeOpenAI(opts?: {
  handler?: FakeOpenAIHandler;
}): Promise<{
  url: string;
  server: Server;
  calls: { n: number };
  bodies: Record<string, unknown>[];
}> {
  const calls = { n: 0 };
  const bodies: Record<string, unknown>[] = [];
  const hanging: Array<{ req: IncomingMessage; res: ServerResponse }> = [];
  const server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(404);
      res.end();
      return;
    }
    calls.n += 1;
    const call = calls.n;
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        // keep {}
      }
      bodies.push(body);
      const wantsJson = (body.response_format as { type?: string } | undefined)?.type === "json_object";
      const defaultJson = completionJson(wantsJson ? JSON.stringify({ ok: true }) : "fake-answer");
      const decided = opts?.handler ? opts.handler(call, body) : { json: defaultJson };
      const delayMs = "delayMs" in decided ? (decided.delayMs ?? 0) : 0;
      const send = () => {
        if ("hang" in decided && decided.hang) {
          hanging.push({ req, res });
          return;
        }
        const status = decided.status ?? 200;
        res.writeHead(status, { "content-type": "application/json" });
        if (status >= 400) {
          res.end(JSON.stringify({ error: { message: "fake-openai-error", type: "server_error" } }));
          return;
        }
        res.end(JSON.stringify(decided.json));
      };
      if (delayMs > 0) setTimeout(send, delayMs);
      else send();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("bind");
      const origClose = server.close.bind(server);
      server.close = ((cb?: (err?: Error) => void) => {
        for (const h of hanging) {
          h.req.destroy();
          h.res.destroy();
        }
        hanging.length = 0;
        return origClose(cb);
      }) as typeof server.close;
      resolve({ url: `http://127.0.0.1:${addr.port}/v1`, server, calls, bodies });
    });
  });
}
