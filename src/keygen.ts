import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Keypair } from "@synonymdev/pubky";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i < 0) return undefined;
  return process.argv[i + 1];
}

export function writeKeyFile(dest: string, secretHex: string): void {
  mkdirSync(dirname(dest), { recursive: true });
  const fd = openSync(dest, "w", 0o600);
  try {
    writeSync(fd, secretHex);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function main(): void {
  const out = arg("--out");
  if (!out) {
    console.error("usage: npm run keygen -- --out <path>");
    process.exit(1);
  }
  const kp = Keypair.random();
  const secret = Buffer.from(kp.secret()).toString("hex");
  try {
    writeKeyFile(resolve(out), secret);
  } catch (e) {
    console.error("keygen write failed");
    process.exit(1);
  }
  process.stdout.write(`${kp.publicKey.z32()}\n`);
}

const isCli = process.argv[1]?.includes("keygen");
if (isCli) main();
