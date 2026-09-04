import { describe, expect, it } from "vitest";
import { detectImageContentType, MAX_ATTACHMENT_BYTES, planFileUpload } from "./upload.js";

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
