import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  assertProfileCopy,
  assertProfilePublishAllowed,
  BOT_PROFILE_BIO,
  BOT_PROFILE_NAME,
  buildBotProfile,
  detectImageContentType,
  MAX_AVATAR_BYTES,
  planAvatarUpload,
  PROFILE_PATH,
} from "./profile.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BOT = "b".repeat(52);

describe("bot profile object", () => {
  it("builds and validates via PubkySpecsBuilder.createUser", () => {
    const p = buildBotProfile(BOT, {
      sourceUrl: "https://github.com/BitcoinErrorLog/pubky-ai-bot",
      policyUrl: "pubky://example/pub/pubky.app/posts/0000000000001",
    });
    expect(p.path).toBe(PROFILE_PATH);
    expect(p.url).toBe(`pubky://${BOT}${PROFILE_PATH}`);
    expect(p.json.name).toBe(BOT_PROFILE_NAME);
    expect(String(p.json.bio)).toContain("Automated account operated by Synonym");
    expect(String(p.json.bio).length).toBeLessThanOrEqual(160);
    expect(p.json.status).toBe("automated");
    const links = p.json.links as Array<{ title: string; url: string }>;
    expect(links.map((l) => l.title)).toEqual(["Source code", "How I work"]);
  });

  it("builds without links when env URLs are unset", () => {
    const p = buildBotProfile(BOT, {});
    expect(p.json.name).toBe(BOT_PROFILE_NAME);
    expect(p.json.bio).toBe(BOT_PROFILE_BIO);
    expect(p.json.links ?? null).toBeNull();
  });

  it("rejects publish under contract mode or the replies/global switches", () => {
    expect(() => assertProfilePublishAllowed({ contractMode: true, repliesSwitchOn: false })).toThrow(/JEB_CONTRACT_MODE/);
    expect(() => assertProfilePublishAllowed({ contractMode: false, repliesSwitchOn: true })).toThrow(/switch/);
    expect(() => assertProfilePublishAllowed({ contractMode: false, repliesSwitchOn: false })).not.toThrow();
  });
});

describe("profile script --dry-run", () => {
  it("prints the profile JSON without any key material or network", async () => {
    const env = { ...process.env };
    delete env.PUBKY_BOT_SECRET_KEY_HEX;
    delete env.PUBKY_BOT_SECRET_KEY_FILE;
    delete env.PUBKY_BOT_MNEMONIC;
    delete env.JEB_PROFILE_NAME;
    delete env.JEB_PROFILE_BIO;
    delete env.JEB_PROFILE_STATUS;
    const { stdout } = await execFileAsync(
      process.execPath,
      [path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"), path.join(repoRoot, "scripts", "profile.ts"), "--dry-run"],
      { env: { ...env, JEB_BOT_PK: BOT, JEB_SOURCE_URL: "https://example.com/repo" }, timeout: 30_000 },
    );
    const json = JSON.parse(stdout) as { name: string; bio: string; status: string; links: Array<{ url: string }> };
    expect(json.name).toBe(BOT_PROFILE_NAME);
    expect(json.status).toBe("automated");
    expect(json.links.map((l) => l.url)).toContain("https://example.com/repo");
    expect(stdout).not.toMatch(/[0-9a-f]{64}/);
  });

  it("refuses under JEB_CONTRACT_MODE=1", async () => {
    const env = { ...process.env, JEB_CONTRACT_MODE: "1", JEB_BOT_PK: BOT };
    await expect(
      execFileAsync(
        process.execPath,
        [path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"), path.join(repoRoot, "scripts", "profile.ts"), "--dry-run"],
        { env, timeout: 30_000 },
      ),
    ).rejects.toThrow();
  });
});

const pngMagic = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]);
const jpegMagic = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const webpMagic = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x10, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0, 0, 0, 0,
]);

describe("avatar magic bytes and size cap", () => {
  it("detects PNG, JPEG, and WebP from magic bytes", () => {
    expect(detectImageContentType(pngMagic)).toBe("image/png");
    expect(detectImageContentType(jpegMagic)).toBe("image/jpeg");
    expect(detectImageContentType(webpMagic)).toBe("image/webp");
    expect(() => detectImageContentType(Uint8Array.from([0x00, 0x01, 0x02, 0x03]))).toThrow(/PNG, JPEG, WebP, or GIF/);
  });

  it("rejects avatars larger than 1 MiB", () => {
    const tooBig = new Uint8Array(MAX_AVATAR_BYTES + 1);
    tooBig.set(pngMagic.subarray(0, 8), 0);
    expect(() => planAvatarUpload(BOT, tooBig, "huge.png")).toThrow(/exceeds/);
  });
});

describe("avatar blob/file plan and profile.image", () => {
  it("builds blob and file URIs and a valid profile with image set to the file URI", () => {
    const plan = planAvatarUpload(BOT, pngMagic, "jeb.png");
    expect(plan.contentType).toBe("image/png");
    expect(plan.blobPath).toMatch(/^\/pub\/pubky\.app\/blobs\/[A-Z0-9]+$/);
    expect(plan.filePath).toMatch(/^\/pub\/pubky\.app\/files\/[A-Z0-9]+$/);
    expect(plan.blobUrl).toBe(`pubky://${BOT}${plan.blobPath}`);
    expect(plan.fileUrl).toBe(`pubky://${BOT}${plan.filePath}`);
    expect(plan.fileJson.src).toBe(plan.blobUrl);
    expect(plan.fileJson.content_type).toBe("image/png");
    expect(plan.fileJson.name).toBe("jeb.png");
    expect(plan.fileJson.size).toBe(pngMagic.length);

    const p = buildBotProfile(BOT, {}, { image: plan.fileUrl });
    expect(p.json.image).toBe(plan.fileUrl);
    expect(p.json.name).toBe(BOT_PROFILE_NAME);
    expect(String(p.json.bio).length).toBeLessThanOrEqual(160);
  });

  it("rejects name and bio outside spec limits", () => {
    expect(() => assertProfileCopy({ name: "Je", bio: BOT_PROFILE_BIO })).toThrow(/JEB_PROFILE_NAME/);
    expect(() => assertProfileCopy({ name: "x".repeat(51), bio: BOT_PROFILE_BIO })).toThrow(/JEB_PROFILE_NAME/);
    expect(() => assertProfileCopy({ name: "Jeb", bio: "x".repeat(161) })).toThrow(/JEB_PROFILE_BIO/);
  });
});
