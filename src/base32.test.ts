import { describe, expect, it } from "vitest";
import { base32Encode, zbase32Encode } from "./base32.js";

const b = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("base32Encode (RFC 4648 test vectors)", () => {
  it.each([
    ["", ""],
    ["f", "MY======"],
    ["fo", "MZXQ===="],
    ["foo", "MZXW6==="],
    ["foob", "MZXW6YQ="],
    ["fooba", "MZXW6YTB"],
    ["foobar", "MZXW6YTBOI======"],
  ])("encodes %s as %s", (input, expected) => {
    expect(base32Encode(b(input))).toBe(expected);
  });

  it("omits padding when asked", () => {
    expect(base32Encode(b("foo"), { padding: false })).toBe("MZXW6");
    expect(base32Encode(b("foobar"), { padding: false })).toBe("MZXW6YTBOI");
  });

  it("encodes a 32-byte key to 52 chars unpadded, 56 padded", () => {
    const key = new Uint8Array(32).fill(0xab);
    expect(base32Encode(key, { padding: false })).toHaveLength(52);
    expect(base32Encode(key)).toHaveLength(56);
  });
});

describe("zbase32Encode", () => {
  it("uses the z-base-32 alphabet over the same bit packing as RFC 4648", () => {
    const rfc = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    const z = "ybndrfg8ejkmcpqxot1uwisza345h769";
    const samples = [b("f"), b("foo"), b("foobar"), new Uint8Array([0x86, 0x4f, 0xd2, 0x6f, 0xb5, 0x59, 0xf7, 0x5b])];
    for (const bytes of samples) {
      const translated = [...base32Encode(bytes, { padding: false })]
        .map((c) => z[rfc.indexOf(c)])
        .join("");
      expect(zbase32Encode(bytes)).toBe(translated);
    }
  });

  it("never pads and stays lowercase", () => {
    const out = zbase32Encode(b("hello world, this is z-base-32"));
    expect(out).toMatch(/^[ybndrfg8ejkmcpqxot1uwisza345h769]+$/);
  });
});
