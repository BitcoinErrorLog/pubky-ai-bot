import { describe, expect, it } from "vitest";
import { isAllowedResourceLabel } from "./resource-label-policy.js";

describe("resource label policy", () => {
  it("rejects post form and sharing fillers", () => {
    for (const label of ["shared-link", "x-post", "video-link", "link", "post", "repost", "shared"]) {
      expect(isAllowedResourceLabel(label)).toBe(false);
    }
    expect(isAllowedResourceLabel("bitcoin")).toBe(true);
  });
});
