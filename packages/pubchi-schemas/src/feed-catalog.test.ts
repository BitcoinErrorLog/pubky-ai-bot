import { describe, expect, it } from "vitest";
import {
  APP_FEED_CONTENT,
  APP_FEED_REACH,
  APP_SUPPORTED_LAYOUT,
  APP_SUPPORTED_SORT,
} from "./feed.js";
import { FEED_CATALOG } from "./feed-catalog.js";

describe("FEED_CATALOG", () => {
  it("contains every enum value from FeedProposalV2 and no extras", () => {
    const fields = new Map(FEED_CATALOG.fields.map((field) => [field.name, field.values]));
    expect(fields.get("reach")).toEqual(APP_FEED_REACH);
    expect(fields.get("sort")).toEqual(APP_SUPPORTED_SORT);
    expect(fields.get("layout")).toEqual(APP_SUPPORTED_LAYOUT);
    expect(fields.get("content")).toEqual(APP_FEED_CONTENT);
  });

  it("documents every authorable and restricted field", () => {
    expect(FEED_CATALOG.fields.map((field) => field.name)).toEqual([
      "name",
      "icon",
      "tags",
      "domain_tags",
      "reach",
      "sort",
      "layout",
      "content",
    ]);
    for (const field of FEED_CATALOG.fields) {
      expect(field.meaning.length).toBeGreaterThan(0);
      expect(field.authoring.length).toBeGreaterThan(0);
    }
    expect(FEED_CATALOG.fields.find((field) => field.name === "reach")?.authoring).toContain("Followers");
    expect(FEED_CATALOG.fields.find((field) => field.name === "content")?.authoring).toContain("all content");
  });
});
