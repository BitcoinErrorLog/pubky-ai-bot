import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Keypair } from "@synonymdev/pubky";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i < 0) return undefined;
  return process.argv[i + 1];
}

const out = arg("--out");
if (!out) {
  console.error("usage: npm run keygen -- --out <path>");
  process.exit(1);
}
const kp = Keypair.random();
const secret = Buffer.from(kp.secret()).toString("hex");
const dest = resolve(out);
mkdirSync(dirname(dest), { recursive: true });
const stream = createWriteStream(dest, { mode: 0o600, flags: "w" });
stream.write(secret);
stream.end();
stream.on("finish", () => {
  process.stdout.write(`${kp.publicKey.z32()}\n`);
});
