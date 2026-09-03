import { createServer, type Server } from "node:http";

/** Test-only OpenAI-compatible stub. Never import from src/. */
export function startFakeOpenAI(): Promise<{ url: string; server: Server; calls: { n: number } }> {
  const calls = { n: 0 };
  const server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(404);
      res.end();
      return;
    }
    calls.n += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "fake-answer" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }),
    );
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("bind");
      resolve({ url: `http://127.0.0.1:${addr.port}/v1`, server, calls });
    });
  });
}
