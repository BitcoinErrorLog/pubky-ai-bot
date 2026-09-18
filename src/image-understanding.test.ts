import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import {
  ImageContext,
  candidatesFromPost,
  downloadImage,
  isPublicIp,
  resolvePublicHost,
} from "./image-understanding.js";

const AUTHOR = "1".repeat(52);
const FILE = `pubky://${AUTHOR}/pub/pubky.app/files/0000000000001`;
const fixture = new URL("../tests/fixtures/images/one-pixel.png", import.meta.url);
const servers: ReturnType<typeof createServer>[] = [];

const cfg = {
  imageEnabled: true,
  imageMaxCount: 2,
  imageMaxBytes: 1024,
  imageTotalMaxBytes: 1500,
  imageTimeoutMs: 500,
  imageCdnUrl: "https://cdn.example/static",
  imageAllowedHosts: new Set(["cdn.example", "images.example", "image.test", "127.0.0.1"]),
} as Config;

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("image candidate extraction", () => {
  it("resolves Pubky attachments and article attachment slots through the public CDN path", () => {
    const out = candidatesFromPost({
      uri: "post", createdAt: 1, author: AUTHOR, name: "u", kind: "long",
      content: JSON.stringify({ title: "t", body: "Look ![pixel](attachment:0)" }),
      attachments: [FILE],
    }, "mention", cfg);
    expect(out.map((x) => x.url.href)).toEqual([
      `https://cdn.example/static/files/${AUTHOR}/0000000000001/main`,
      `https://cdn.example/static/files/${AUTHOR}/0000000000001/main`,
    ]);
  });

  it("accepts only explicit HTTP(S) hosts and ignores data, private Pubky paths, and other hosts", () => {
    const out = candidatesFromPost({
      uri: "post", createdAt: 1, author: AUTHOR, name: "u",
      content: "![ok](https://images.example/a.png) ![bad](data:image/png;base64,AA) ![host](https://evil.example/a.png)",
      attachments: [`pubky://${AUTHOR}/private/files/0000000000001`],
    }, "mention", cfg);
    expect(out.map((x) => x.url.href)).toEqual(["https://images.example/a.png"]);
  });
});

describe("SSRF controls", () => {
  it.each(["127.0.0.1", "10.0.0.1", "169.254.1.1", "192.168.1.1", "100.64.0.1", "::1", "fe80::1", "fc00::1", "2001:2::1", "2001:db8::1", "2001:0db8::1", "2002:7f00:1::", "2001:0000:4136:e378::", "2001::4136:e378:8000:63bf:3fff:fdd2", "3fff::1"])(
    "rejects non-public address %s",
    (ip) => expect(isPublicIp(ip)).toBe(false),
  );

  it("accepts global addresses and rejects a hostname if any answer is private", async () => {
    expect(isPublicIp("1.1.1.1")).toBe(true);
    expect(isPublicIp("2606:4700:4700::1111")).toBe(true);
    await expect(resolvePublicHost("mixed.example", {
      lookup: async () => [{ address: "1.1.1.1", family: 4 }, { address: "127.0.0.1", family: 4 }],
    })).rejects.toThrow(/non-public/);
  });
});

async function fixtureServer(opts?: { contentType?: string; repeat?: number; delayMs?: number; status?: number }): Promise<string> {
  const bytes = await readFile(fixture);
  const server = createServer((_req, res) => {
    const send = () => {
      res.writeHead(opts?.status ?? 200, { "content-type": opts?.contentType ?? "image/png" });
      for (let i = 0; i < (opts?.repeat ?? 1); i++) res.write(bytes);
      res.end();
    };
    if (opts?.delayMs) setTimeout(send, opts.delayMs);
    else send();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/fixture.png`;
}

describe("bounded image download and decoding", () => {
  it("streams and structurally decodes the real PNG fixture", async () => {
    const url = await fixtureServer();
    const loaded = await downloadImage({ url: new URL(url), source: "mention" }, cfg, 1024, {
      allowPrivateForTests: true,
    });
    expect(loaded.mimeType).toBe("image/png");
    expect(loaded.bytes.byteLength).toBeGreaterThan(32);
  });

  it("pins an allowlisted hostname connection to the address validated by the resolver", async () => {
    const local = new URL(await fixtureServer());
    local.hostname = "image.test";
    const loaded = await downloadImage({ url: local, source: "mention" }, cfg, 1024, {
      lookup: async (hostname) => {
        expect(hostname).toBe("image.test");
        return [{ address: "127.0.0.1", family: 4 }];
      },
      allowPrivateForTests: true,
    });
    expect(loaded.mimeType).toBe("image/png");
  });

  it("enforces streamed bytes even without Content-Length and matches MIME to magic bytes", async () => {
    const tooLarge = await fixtureServer({ repeat: 30 });
    await expect(downloadImage({ url: new URL(tooLarge), source: "mention" }, { ...cfg, imageMaxBytes: 100 }, 100, {
      allowPrivateForTests: true,
    })).rejects.toThrow(/stream exceeds/);
    const wrongType = await fixtureServer({ contentType: "image/jpeg" });
    await expect(downloadImage({ url: new URL(wrongType), source: "mention" }, cfg, 1024, {
      allowPrivateForTests: true,
    })).rejects.toThrow(/does not match/);
  });

  it("enforces timeout", async () => {
    const url = await fixtureServer({ delayMs: 100 });
    await expect(downloadImage({ url: new URL(url), source: "mention" }, { ...cfg, imageTimeoutMs: 10 }, 1024, {
      allowPrivateForTests: true,
    })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects null-body statuses through the promise instead of throwing from the response callback", async () => {
    const url = await fixtureServer({ status: 204 });
    await expect(downloadImage({ url: new URL(url), source: "mention" }, cfg, 1024, {
      allowPrivateForTests: true,
    })).rejects.toThrow(/image response 204/);
  });

  it("honours a caller abort during download", async () => {
    const url = await fixtureServer({ delayMs: 100 });
    const ac = new AbortController();
    const pending = downloadImage({ url: new URL(url), source: "mention" }, cfg, 1024, {
      allowPrivateForTests: true,
      abortSignal: ac.signal,
    });
    ac.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("includes DNS resolution in the timeout", async () => {
    await expect(downloadImage({ url: new URL("https://images.example/a.png"), source: "mention" }, {
      ...cfg, imageTimeoutMs: 10,
    }, 1024, {
      lookup: async () => await new Promise<never>(() => {}),
    })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("deduplicates candidates and emits bounded multimodal context once", async () => {
    const bytes = await readFile(fixture);
    const context = new ImageContext(cfg, {
      fetchImpl: async () => new Response(bytes, { headers: { "content-type": "image/png" } }),
      allowPrivateForTests: true,
    });
    const post = { uri: "p", createdAt: 1, author: AUTHOR, name: "u", content: "", attachments: [FILE, FILE] };
    await context.addPosts([post], "mention");
    const message = context.takeMessage();
    expect(Array.isArray(message?.content) && message.content.filter((x) => x.type === "image")).toHaveLength(1);
    expect(context.takeMessage()).toBeNull();
  });

  it("resolves Scout author_id/post_id evidence back through Nexus before loading its image", async () => {
    const bytes = await readFile(fixture);
    const seen: string[] = [];
    const context = new ImageContext(cfg, {
      fetchImpl: async () => new Response(bytes, { headers: { "content-type": "image/png" } }),
      fetchPost: async (uri) => {
        seen.push(uri);
        return { uri, createdAt: 1, author: AUTHOR, name: "u", content: "", attachments: [FILE] };
      },
      allowPrivateForTests: true,
    });
    await context.addEvidence({ rows: [{ author_id: AUTHOR, post_id: "0000000000001", content: "Scout text" }] });
    expect(seen).toEqual([`pubky://${AUTHOR}/pub/pubky.app/posts/0000000000001`]);
    const message = context.takeMessage();
    expect(Array.isArray(message?.content) && message.content.some((x) => x.type === "image")).toBe(true);
  });
});
