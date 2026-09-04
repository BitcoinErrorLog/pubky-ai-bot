import { describe, expect, it } from "vitest";
import {
  assertUploadBytesClean,
  detectImageContentType,
  isKnownImageType,
  MAX_ATTACHMENT_BYTES,
  planFileUpload,
} from "./upload.js";

const pngMagic = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]);
const gif87a = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 0, 1]);
const gif89a = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 1]);
const BOT = "b".repeat(52);

describe("image magic bytes", () => {
  it("detects GIF87a and GIF89a as image/gif", () => {
    expect(detectImageContentType(gif87a)).toBe("image/gif");
    expect(detectImageContentType(gif89a)).toBe("image/gif");
    expect(detectImageContentType(pngMagic)).toBe("image/png");
    expect(() => detectImageContentType(Uint8Array.from([0x00, 0x01, 0x02, 0x03]))).toThrow(
      /PNG, JPEG, WebP, or GIF/,
    );
  });

  it("rejects attachments larger than 5 MiB", () => {
    const tooBig = new Uint8Array(MAX_ATTACHMENT_BYTES + 1);
    tooBig.set(gif89a.subarray(0, 6), 0);
    expect(() =>
      planFileUpload(BOT, tooBig, "huge.gif", { maxBytes: MAX_ATTACHMENT_BYTES, label: "attachment" }),
    ).toThrow(/exceeds/);
  });
});

describe("assertUploadBytesClean (secret scan before any PUT under the bot key)", () => {
  const KEY = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
  const env = { PUBKY_BOT_SECRET_KEY_HEX: KEY };
  const utf8 = (s: string) => new TextEncoder().encode(s);

  it("refuses a text attachment containing the configured key (the --attach .env case)", () => {
    const dotenv = utf8(`# dumped config\nPUBKY_BOT_SECRET_KEY_HEX=${KEY}\n`);
    expect(() => assertUploadBytesClean(dotenv, { env })).toThrowError(/key_material|env_secret|env_assignment/);
    expect(() => assertUploadBytesClean(dotenv, { env })).toThrowError(/^((?!9f86d081).)*$/s);
  });

  it("refuses unknown binary-ish payloads containing the key as utf8 text", () => {
    const logExport = utf8(`[log] loaded key ${KEY} at startup`);
    expect(() => assertUploadBytesClean(logExport, { env })).toThrowError(/key_material|env_secret/);
  });

  it("passes clean text payloads", () => {
    expect(() => assertUploadBytesClean(utf8("release notes: nothing sensitive"), { env })).not.toThrow();
  });

  it("exempts recognized binary image types even when secret-looking bytes appear later", () => {
    const png = new Uint8Array(96);
    png.set(pngMagic, 0);
    png.set(utf8(KEY), 16);
    expect(isKnownImageType(png)).toBe(true);
    expect(() => assertUploadBytesClean(png, { env })).not.toThrow();
  });
});
