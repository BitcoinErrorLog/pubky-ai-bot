import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  assertPostPublishAllowed,
  buildCollectionPost,
  buildStandalonePost,
  collectionItemLimit,
  collectionPostId,
  parseEditId,
  parseKeptAttachment,
  contentFromFile,
  MAX_POST_ATTACHMENTS,
  parseKind,
} from "./post.js";
import { planFileUpload } from "./upload.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BOT = "b".repeat(52);

async function runPostScript(
  args: string[],
  extraEnv: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
  const env = { ...process.env, ...extraEnv };
  delete env.PUBKY_BOT_SECRET_KEY_HEX;
  delete env.PUBKY_BOT_SECRET_KEY_FILE;
  delete env.PUBKY_BOT_MNEMONIC;
  return execFileAsync(
    process.execPath,
    [path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"), path.join(repoRoot, "scripts", "post.ts"), ...args],
    { env, timeout: 60_000 },
  );
}

describe("standalone post builder", () => {
  it("builds a valid short post via createPost", () => {
    const p = buildStandalonePost(BOT, "Hello from Jeb.", "short");
    expect(p.path).toMatch(/^\/pub\/pubky\.app\/posts\/[A-Z0-9]+$/);
    expect(p.url).toBe(`pubky://${BOT}${p.path}`);
    expect(p.json.kind).toBe("short");
    expect(p.json.content).toBe("Hello from Jeb.");
    expect(p.json.parent ?? null).toBeNull();
  });

  it("validates long JSON {title, body} as content", () => {
    const content = contentFromFile(JSON.stringify({ title: "How I work", body: "Public data only." }), "long");
    expect(content).toBe(JSON.stringify({ title: "How I work", body: "Public data only." }));
    const p = buildStandalonePost(BOT, content, "long");
    expect(p.json.kind).toBe("long");
    expect(p.json.content).toBe(content);
    const inner = JSON.parse(String(p.json.content)) as { title: string; body: string };
    expect(inner.title).toBe("How I work");
    expect(inner.body).toBe("Public data only.");
  });

  it("rejects over-limit short and long content via specs validation", () => {
    expect(() => buildStandalonePost(BOT, "x".repeat(2001), "short")).toThrow(/2000/);
    expect(() => buildStandalonePost(BOT, "x".repeat(50_001), "long")).toThrow(/50000/);
  });

  it("rejects publish under contract mode or the replies/global/proactive switches", () => {
    expect(() => assertPostPublishAllowed({ contractMode: true, repliesSwitchOn: false })).toThrow(/JEB_CONTRACT_MODE/);
    expect(() => assertPostPublishAllowed({ contractMode: false, repliesSwitchOn: true })).toThrow(/switch/);
    expect(() => assertPostPublishAllowed({ contractMode: false, repliesSwitchOn: false, proactiveSwitchOn: true })).toThrow(
      /proactive/,
    );
    expect(() => assertPostPublishAllowed({ contractMode: false, repliesSwitchOn: false })).not.toThrow();
  });

  it("defaults kind to short", () => {
    expect(parseKind(undefined)).toBe("short");
    expect(parseKind("LONG")).toBe("long");
    expect(() => parseKind("image")).toThrow(/short or long/);
  });

  it("populates attachments with file URIs", () => {
    const gif89a = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 1]);
    const plan = planFileUpload(BOT, gif89a, "kungfu.gif", { maxBytes: 5 * 1024 * 1024, label: "attachment" });
    const p = buildStandalonePost(BOT, "Hello with a file.", "short", [plan.fileUrl]);
    expect(p.json.attachments).toEqual([plan.fileUrl]);
    expect(String(plan.fileUrl)).toMatch(new RegExp(`^pubky://${BOT}/pub/pubky\\.app/files/`));
  });

  it("rejects more than 10 attachments", () => {
    const uris = Array.from({ length: MAX_POST_ATTACHMENTS + 1 }, (_, i) => `pubky://${BOT}/pub/pubky.app/files/${String(i).padStart(13, "A")}`);
    expect(() => buildStandalonePost(BOT, "too many files", "short", uris)).toThrow(/at most 10/);
  });
});

describe("post script --dry-run", () => {
  it("prints validated JSON and path for a short post", { timeout: 60_000 }, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "jeb-post-"));
    const file = path.join(dir, "short.txt");
    await writeFile(file, "Standalone short post for dry-run.", "utf8");
    const { stdout } = await runPostScript(["--dry-run", "--file", file], { JEB_BOT_PK: BOT });
    expect(stdout).toMatch(/"kind": "short"/);
    expect(stdout).toMatch(/"content": "Standalone short post for dry-run\."/);
    expect(stdout).toMatch(/^path: \/pub\/pubky\.app\/posts\/[A-Z0-9]+$/m);
    expect(stdout).not.toMatch(/[0-9a-f]{64}/);
  });

  it("validates long JSON form", { timeout: 60_000 }, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "jeb-post-"));
    const file = path.join(dir, "long.json");
    await writeFile(file, JSON.stringify({ title: "Essay", body: "Body text." }), "utf8");
    const { stdout } = await runPostScript(["--dry-run", "--kind", "long", "--file", file], { JEB_BOT_PK: BOT });
    expect(stdout).toMatch(/"kind": "long"/);
    const jsonLine = stdout.split("\npath:")[0] ?? stdout;
    const json = JSON.parse(jsonLine) as { content: string; kind: string };
    expect(json.kind).toBe("long");
    expect(JSON.parse(json.content)).toEqual({ title: "Essay", body: "Body text." });
  });

  it("rejects over-limit content", { timeout: 60_000 }, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "jeb-post-"));
    const file = path.join(dir, "too-long.txt");
    await writeFile(file, "x".repeat(2001), "utf8");
    await expect(runPostScript(["--dry-run", "--file", file], { JEB_BOT_PK: BOT })).rejects.toThrow(/2000/);
  });

  it("refuses under JEB_CONTRACT_MODE=1", { timeout: 60_000 }, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "jeb-post-"));
    const file = path.join(dir, "short.txt");
    await writeFile(file, "ok", "utf8");
    await expect(
      runPostScript(["--dry-run", "--file", file], { JEB_CONTRACT_MODE: "1", JEB_BOT_PK: BOT }),
    ).rejects.toThrow();
  });

  it("rejects more than 10 --attach flags", { timeout: 60_000 }, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "jeb-post-"));
    const file = path.join(dir, "short.txt");
    await writeFile(file, "ok", "utf8");
    const gif = path.join(dir, "a.gif");
    await writeFile(gif, Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 1]));
    const args = ["--dry-run", "--file", file];
    for (let i = 0; i < 11; i++) args.push("--attach", gif);
    await expect(runPostScript(args, { JEB_BOT_PK: BOT })).rejects.toThrow(/at most 10/);
  });
});

describe("edit in place", () => {
  it("keeps the given id and URI", () => {
    const p = buildStandalonePost(BOT, "Edited.", "short", null, "0035n8nr4ate0");
    expect(p.id).toBe("0035N8NR4ATE0");
    expect(p.path).toBe("/pub/pubky.app/posts/0035N8NR4ATE0");
    expect(p.url).toBe(`pubky://${BOT}/pub/pubky.app/posts/0035N8NR4ATE0`);
    expect(p.json.content).toBe("Edited.");
  });
  it("rejects malformed ids and foreign attachments", () => {
    expect(() => parseEditId("short")).toThrow(/13-character/);
    expect(() => parseKeptAttachment(`pubky://${BOT}/pub/pubky.app/files/0035N8Q4NFST0`, BOT)).not.toThrow();
    expect(() => parseKeptAttachment("pubky://" + "a".repeat(52) + "/pub/pubky.app/files/0035N8Q4NFST0", BOT)).toThrow(/under the bot key/);
    expect(() => parseKeptAttachment(`pubky://${BOT}/pub/pubky.app/posts/0035N8Q4NFST0`, BOT)).toThrow();
  });
});

describe("collection post builder (pubky-app-specs 0.7.0)", () => {
  const item = "pubky://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/pub/pubky.app/posts/0000000000001";

  it("builds a kind=collection envelope that round-trips", () => {
    const p = buildCollectionPost(BOT, { title: "Homeservers", description: "recurring notes", itemUris: [item], layout: "grid" });
    expect(p.json.kind).toBe("collection");
    expect(p.envelope.name).toBe("Homeservers");
    expect(p.envelope.items).toEqual([item]);
    expect(p.envelope.layout).toBe("grid");
    expect(JSON.parse(p.content)).toMatchObject({ name: "Homeservers", items: [item] });
  });

  it("uses a deterministic edit path from the title", () => {
    const id = collectionPostId("Homeservers");
    const p = buildCollectionPost(BOT, { title: "Homeservers", description: "", itemUris: [item] }, id);
    expect(p.id).toBe(id);
    expect(p.path).toBe(`/pub/pubky.app/posts/${id}`);
  });

  it("rejects empty and over-cap item lists", () => {
    expect(() => buildCollectionPost(BOT, { title: "x", description: "", itemUris: [] })).toThrow(/non-empty/);
    const cap = collectionItemLimit();
    expect(() =>
      buildCollectionPost(BOT, { title: "x", description: "", itemUris: Array.from({ length: cap + 1 }, () => item) }),
    ).toThrow(/collectionItemsMaxCount/);
  });
});
