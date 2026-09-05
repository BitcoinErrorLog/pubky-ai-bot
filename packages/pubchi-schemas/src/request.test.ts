import { describe, expect, it } from "vitest";
import { bodySha256 } from "./canonical.js";

describe("body hash coerce", () => {
  it("hashes a missing body as null", () => {
    expect(bodySha256(undefined)).toBe(bodySha256(null));
  });
});
