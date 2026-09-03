import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  assertProfilePublishAllowed,
  BOT_PROFILE_BIO,
  BOT_PROFILE_NAME,
  buildBotProfile,
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
