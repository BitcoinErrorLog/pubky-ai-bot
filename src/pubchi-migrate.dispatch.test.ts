import { spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const mainTs = path.join(repoRoot, "src", "main.ts");
const pgStub = path.join(repoRoot, "tests", "helpers", "pubchi-migrate-pg-stub.mjs");

function listenProbe(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

describe("pubchi-migrate process dispatch", () => {
  it("exits 0 with the applied log and never binds HTTP", async () => {
    const output: Buffer[] = [];
    const child = spawn(
      process.execPath,
      [
        "--preserve-symlinks",
        "--preserve-symlinks-main",
        "--import",
        "tsx",
        "--import",
        pgStub,
        mainTs,
        "--role",
        "pubchi-migrate",
      ],
      {
        cwd: repoRoot,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          NODE_ENV: "test",
          DATABASE_URL: "postgres://migrator@127.0.0.1:1/pubchi",
          JEB_LOG_LEVEL: "info",
        },
      },
    );
    child.stdout?.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => output.push(chunk));

    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("pubchi-migrate did not exit"));
      }, 15_000);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("exit", (exitCode) => {
        clearTimeout(timer);
        resolve(exitCode);
      });
    });

    const logs = Buffer.concat(output).toString("utf8");
    expect(code).toBe(0);
    expect(logs).toMatch(/"role":"pubchi-migrate"/);
    expect(logs).toMatch(/"mode":"migration"/);
    expect(logs).toContain("Pubchi migrations applied");
    expect(logs).not.toMatch(/"mode":"runtime"/);
    expect(logs).not.toContain("started");
    expect(logs).not.toMatch(/listen/i);
    await expect(listenProbe("127.0.0.1", 3015)).resolves.toBe(true);
  });
});
