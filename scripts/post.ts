#!/usr/bin/env npx tsx
/**
 * Operator tool: publish a standalone post under the bot key.
 *
 *   npm run post:publish -- --file ./intro.txt
 *   npm run post:publish -- --dry-run --file ./intro.txt
 *   npm run post:publish -- --kind long --file ./essay.json
 *
 * `--file` is UTF-8. `--kind long` accepts plain text or JSON `{title, body}`
 * (the latter is stored as the post `content`, matching operator long posts).
 * `--attach <path>` (repeatable, max 10): PNG/JPEG/WebP/GIF ≤ 5 MiB each.
 * Upload order matches profile `--image`: blob bytes, then file JSON, then
 * the post `attachments` array is those file URIs.
 * Specs validation: 2000 chars (short) / 50000 (long) via createPost.
 * Key loading is src/keys.ts. Refuses under JEB_CONTRACT_MODE=1 and under
 * the replies/global kill switches. Voice linter warnings are printed and
 * do not block.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Store } from "../src/db.js";
import { openTransport, publicBotPk } from "../src/homeserver.js";
import { secretFromEnv } from "../src/keys.js";
import { postAppUrl } from "../src/links.js";
import {
  assertAttachmentCount,
  assertPostPublishAllowed,
  buildStandalonePost,
  contentFromFile,
  parseKind,
} from "../src/post.js";
import { assertOutboundClean } from "../src/outbound-gate.js";
import { envSwitchOn } from "../src/switches.js";
import { MAX_ATTACHMENT_BYTES, assertUploadBytesClean, planFileUpload, type FileUploadPlan } from "../src/upload.js";
import { lintVoice } from "../src/voice.js";

const dryRun = process.argv.includes("--dry-run");

function flagValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  if (!v || v.startsWith("--")) throw new Error(`${name} requires a value`);
  return v;
}

function flagValues(name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] !== name) continue;
    const v = process.argv[i + 1];
    if (!v || v.startsWith("--")) throw new Error(`${name} requires a file path`);
    out.push(v);
  }
  return out;
}

function trySecret(): string | undefined {
  try {
    return secretFromEnv();
  } catch {
    return undefined;
  }
}

function warnVoice(content: string): void {
  const { violations } = lintVoice(content);
  for (const v of violations) {
    process.stderr.write(`voice warning: ${v.rule}: ${v.detail}\n`);
  }
}

async function main(): Promise<void> {
  assertPostPublishAllowed({ contractMode: process.env.JEB_CONTRACT_MODE === "1", repliesSwitchOn: false });

  const filePath = flagValue("--file");
  if (!filePath) throw new Error("--file <path> is required");
  const kind = parseKind(flagValue("--kind"));
  const raw = await readFile(filePath, "utf8");
  const content = contentFromFile(raw, kind);
  // Outbound gate: refuse to put secret-shaped text under the bot key,
  // even by hand. Rule ids only; the matched text is never printed.
  assertOutboundClean(content);
  const attachPaths = flagValues("--attach");
  assertAttachmentCount(attachPaths.length);

  const secret = dryRun ? trySecret() : secretFromEnv();
  const botPk = secret ? publicBotPk(secret) : process.env.JEB_BOT_PK?.trim();
  if (!botPk || !/^[a-z0-9]{52}$/.test(botPk)) {
    throw new Error("bot id unknown: set key material (publisher env) or JEB_BOT_PK");
  }

  const uploads: FileUploadPlan[] = [];
  for (const attachPath of attachPaths) {
    const bytes = new Uint8Array(await readFile(attachPath));
    // Text/unknown payloads are secret-scanned before any PUT under the bot
    // key (recognized binary image types are exempt).
    assertUploadBytesClean(bytes);
    uploads.push(planFileUpload(botPk, bytes, path.basename(attachPath), { maxBytes: MAX_ATTACHMENT_BYTES, label: "attachment" }));
  }
  const attachmentUris = uploads.map((u) => u.fileUrl);
  const post = buildStandalonePost(botPk, content, kind, attachmentUris.length ? attachmentUris : null);
  warnVoice(content);

  if (dryRun) {
    for (const upload of uploads) {
      process.stdout.write(`blob path: ${upload.blobPath}\n`);
      process.stdout.write(`blob uri: ${upload.blobUrl}\n`);
      process.stdout.write(`file path: ${upload.filePath}\n`);
      process.stdout.write(`file uri: ${upload.fileUrl}\n`);
    }
    process.stdout.write(`${JSON.stringify(post.json, null, 2)}\n`);
    process.stdout.write(`path: ${post.path}\n`);
    return;
  }

  let repliesOn = envSwitchOn("replies") || envSwitchOn("global");
  const dbUrl = process.env.DATABASE_URL?.trim();
  if (!repliesOn && dbUrl) {
    const store = new Store(dbUrl);
    try {
      await store.migrate();
      repliesOn = await store.switchOn("replies");
    } finally {
      await store.close();
    }
  }
  assertPostPublishAllowed({ contractMode: false, repliesSwitchOn: repliesOn });
  if (!secret) throw new Error("key material required to publish the post");

  const transport = await openTransport({
    secretKeyHex: secret,
    homeserverPk: process.env.JEB_HOMESERVER?.trim() ?? "",
    signupToken: process.env.JEB_SIGNUP_TOKEN?.trim() || undefined,
    testnet: process.env.JEB_TESTNET === "1",
  });
  for (const upload of uploads) {
    await transport.putBytes(upload.blobPath, upload.bytes);
    await transport.putJson(upload.filePath, upload.fileJson);
    process.stdout.write(`file uri: ${upload.fileUrl}\n`);
  }
  await transport.putJson(post.path, post.json);

  const { Pubky } = await import("@synonymdev/pubky");
  const pubky = process.env.JEB_TESTNET === "1" ? Pubky.testnet() : new Pubky();
  const read = await pubky.publicStorage.getJson(post.url as never);
  if (!read || typeof read !== "object") throw new Error("post readback failed");

  const appLink = postAppUrl(botPk, post.id);
  process.stdout.write(`${post.url}\n`);
  process.stdout.write(`${appLink}\n`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
