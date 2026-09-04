#!/usr/bin/env npx tsx
/**
 * Operator tool: publish Jeb's transparent bot profile
 * (/pub/pubky.app/profile.json) under the bot key. Run once, or on change.
 *
 *   npm run profile:publish            # PUT via the SDK
 *   npm run profile:publish -- --dry-run   # print the JSON, no network, no key needed
 *   npm run profile:publish -- --dry-run --image ./avatar.png
 *
 * Links come from JEB_SOURCE_URL (source repo) and JEB_HOW_I_WORK_POST_URI
 * (or JEB_POLICY_URL, or --how-i-work <uri>) for the How I work post.
 * --how-i-work without a URI fails. Copy from JEB_PROFILE_NAME /
 * JEB_PROFILE_BIO / JEB_PROFILE_STATUS. Key loading is src/keys.ts.
 * Refuses under JEB_CONTRACT_MODE=1 and under the replies/global kill switches.
 *
 * --image <path>: PNG/JPEG/WebP ≤ 1 MiB. PUT raw bytes (session.storage.putBytes,
 * no content-type header) at the blob path, PUT file JSON whose src is the
 * blob URI, then set profile.image to the file URI — same order as pubky-app.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Store } from "../src/db.js";
import { openTransport, publicBotPk } from "../src/homeserver.js";
import { secretFromEnv } from "../src/keys.js";
import {
  assertProfilePublishAllowed,
  buildBotProfile,
  planAvatarUpload,
  profileCopyFromEnv,
  resolveHowIWorkPostUri,
} from "../src/profile.js";
import { assertUploadBytesClean } from "../src/upload.js";
import { assertOutboundClean } from "../src/outbound-gate.js";
import { envSwitchOn } from "../src/switches.js";

const dryRun = process.argv.includes("--dry-run");

function flagValue(name: string, what: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  if (!v || v.startsWith("--")) throw new Error(`${name} requires ${what}`);
  return v;
}

function trySecret(): string | undefined {
  try {
    return secretFromEnv();
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  assertProfilePublishAllowed({ contractMode: process.env.JEB_CONTRACT_MODE === "1", repliesSwitchOn: false });

  const secret = dryRun ? trySecret() : secretFromEnv();
  const botPk = secret ? publicBotPk(secret) : process.env.JEB_BOT_PK?.trim();
  if (!botPk || !/^[a-z0-9]{52}$/.test(botPk)) {
    throw new Error("bot id unknown: set key material (publisher env) or JEB_BOT_PK");
  }

  const copy = profileCopyFromEnv();
  const imagePath = flagValue("--image", "a file path");
  const howIWorkRequested = process.argv.includes("--how-i-work");
  const policyUrl = resolveHowIWorkPostUri({
    cliUri: howIWorkRequested ? flagValue("--how-i-work", "a pubky:// or https:// URI") : undefined,
    requested: howIWorkRequested,
  });
  let avatar: ReturnType<typeof planAvatarUpload> | undefined;
  if (imagePath) {
    const bytes = new Uint8Array(await readFile(imagePath));
    // Text/unknown payloads are secret-scanned before any PUT under the bot
    // key (recognized binary image types are exempt).
    assertUploadBytesClean(bytes);
    avatar = planAvatarUpload(botPk, bytes, path.basename(imagePath));
  }

  const profile = buildBotProfile(
    botPk,
    {
      sourceUrl: process.env.JEB_SOURCE_URL?.trim() || undefined,
      policyUrl,
    },
    { name: copy.name, bio: copy.bio, status: copy.status, image: avatar?.fileUrl ?? null },
  );
  // Outbound gate: refuse to put secret-shaped text under the bot key,
  // even by hand. Rule ids only; the matched text is never printed.
  assertOutboundClean(JSON.stringify(profile.json));

  if (dryRun) {
    if (avatar) {
      process.stdout.write(`blob path: ${avatar.blobPath}\n`);
      process.stdout.write(`blob uri: ${avatar.blobUrl}\n`);
      process.stdout.write(`file path: ${avatar.filePath}\n`);
      process.stdout.write(`file uri: ${avatar.fileUrl}\n`);
    }
    process.stdout.write(`${JSON.stringify(profile.json, null, 2)}\n`);
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
  assertProfilePublishAllowed({ contractMode: false, repliesSwitchOn: repliesOn });
  if (!secret) throw new Error("key material required to publish the profile");

  const transport = await openTransport({
    secretKeyHex: secret,
    homeserverPk: process.env.JEB_HOMESERVER?.trim() ?? "",
    signupToken: process.env.JEB_SIGNUP_TOKEN?.trim() || undefined,
    testnet: process.env.JEB_TESTNET === "1",
  });
  if (avatar) {
    await transport.putBytes(avatar.blobPath, avatar.bytes);
    await transport.putJson(avatar.filePath, avatar.fileJson);
    process.stdout.write(`file uri: ${avatar.fileUrl}\n`);
  }
  await transport.putJson(profile.path, profile.json);
  const read = await transport.getJson(profile.path);
  if (!read || typeof read !== "object") throw new Error("profile readback failed");
  process.stdout.write(`profile published at ${profile.url}\n`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
