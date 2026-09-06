import { describe, expect, it } from "vitest";
import { bodySha256, canonicalize } from "./canonical.js";
import { MAX_JSON_DEPTH, scanForbidden } from "./forbidden.js";

describe("body hash coerce", () => {
  it("hashes a missing body as null", () => {
    expect(bodySha256(undefined)).toBe(bodySha256(null));
  });
});

function nest(depth: number): unknown {
  let value: unknown = 0;
  for (let i = 0; i < depth; i += 1) value = [value];
  return value;
}

describe("JSON depth cap", () => {
  it("scanForbidden returns SCHEMA_INVALID for a too-deep value", () => {
    const deep = scanForbidden(nest(MAX_JSON_DEPTH + 2));
    expect(deep).toEqual({ ok: false, code: "SCHEMA_INVALID" });
    expect(scanForbidden(nest(2)).ok).toBe(true);
  });

  it("canonicalize throws RangeError for a too-deep value", () => {
    expect(() => canonicalize(nest(MAX_JSON_DEPTH + 2))).toThrow(RangeError);
    expect(canonicalize(nest(2))).toEqual([[0]]);
  });
});
