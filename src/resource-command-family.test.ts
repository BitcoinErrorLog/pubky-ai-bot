import { describe, expect, it } from "vitest";
import { RESOURCE_COMMAND_FAMILIES, resolveResourceCommandFamily } from "./resource-command-family.js";

describe("exactly-one-family guard", () => {
  it("accepts each single family form", () => {
    expect(resolveResourceCommandFamily(["discover", "--input", "/tmp/in.json"])).toBe("discover");
    expect(resolveResourceCommandFamily(["crawl", "--db", "/tmp/c.sqlite", "--source", "musicbrainz", "--label", "release"])).toBe("crawl");
    expect(resolveResourceCommandFamily(["places"])).toBe("places");
    expect(resolveResourceCommandFamily(["canon", "--source", "bitcoin-canon"])).toBe("canon");
    expect(resolveResourceCommandFamily(["canon"])).toBe("canon");
    expect(resolveResourceCommandFamily(["--source", "pubky-posts"])).toBe("pubky-posts");
  });

  it("ignores unrelated flags and their values", () => {
    expect(resolveResourceCommandFamily(["places", "--limit", "5", "--mode", "shadow", "--target", "staging"])).toBe("places");
    expect(resolveResourceCommandFamily(["--source", "pubky-posts", "--tagger", "model", "--fetch"])).toBe("pubky-posts");
  });

  // Deliberate negatives: every pair among the five families must fail before
  // any dependency call, because dispatch used to pick one silently.
  const pairs: Array<[string, string[]]> = [
    ["discover + crawl", ["discover", "crawl", "--input", "/tmp/in.json", "--db", "/tmp/c.sqlite"]],
    ["discover + places", ["discover", "places", "--input", "/tmp/in.json"]],
    ["discover + canon", ["discover", "canon", "--input", "/tmp/in.json"]],
    ["discover + pubky-posts", ["discover", "--input", "/tmp/in.json", "--source", "pubky-posts"]],
    ["crawl + places", ["crawl", "places", "--db", "/tmp/c.sqlite", "--source", "musicbrainz"]],
    ["crawl + canon", ["crawl", "canon", "--db", "/tmp/c.sqlite", "--source", "musicbrainz"]],
    ["crawl + pubky-posts", ["crawl", "--db", "/tmp/c.sqlite", "--source", "pubky-posts"]],
    ["places + canon", ["places", "canon"]],
    ["places + pubky-posts", ["places", "--source", "pubky-posts"]],
    ["canon + pubky-posts", ["canon", "--source", "pubky-posts"]],
  ];

  it.each(pairs)("refuses the pair %s", (_name, args) => {
    expect(() => resolveResourceCommandFamily(args)).toThrow(/mutually exclusive/);
  });

  it("covers every pair among the five families", () => {
    const expected = (RESOURCE_COMMAND_FAMILIES.length * (RESOURCE_COMMAND_FAMILIES.length - 1)) / 2;
    expect(pairs).toHaveLength(expected);
  });

  // Deliberate negative: no family at all is not a default, it is a refusal.
  it("refuses a run with no family selector", () => {
    expect(() => resolveResourceCommandFamily([])).toThrow(/exactly one family is required/);
    expect(() => resolveResourceCommandFamily(["--limit", "5"])).toThrow(/exactly one family is required/);
  });

  // Deliberate negative: a duplicated command word is an ambiguous invocation.
  it("refuses a repeated positional command", () => {
    expect(() => resolveResourceCommandFamily(["places", "places"])).toThrow(/repeated family command/);
    expect(() => resolveResourceCommandFamily(["discover", "discover", "--input", "/tmp/in.json"])).toThrow(
      /repeated family command/,
    );
  });

  // Deliberate negative: two --source values could select two families.
  it("refuses a repeated --source", () => {
    expect(() => resolveResourceCommandFamily(["canon", "--source", "bitcoin-canon", "--source", "pubky-posts"])).toThrow(
      /--source may be given at most once/,
    );
  });

  it("refuses an unknown command word", () => {
    expect(() => resolveResourceCommandFamily(["publish", "--input", "/tmp/in.json"])).toThrow(/unknown command 'publish'/);
  });

  // Deliberate negatives: family-specific arguments supplied to the wrong
  // family are mismatches, not ignorable extras.
  it.each([
    [["places", "--input", "/tmp/in.json"], /--input belongs to family 'discover'/],
    [["canon", "--db", "/tmp/c.sqlite"], /--db belongs to family 'crawl'/],
    [["discover", "--input", "/tmp/in.json", "--label", "release"], /--label belongs to family 'crawl'/],
    [["places", "--include-withdrawn"], /--include-withdrawn belongs to family 'canon'/],
    [["--source", "pubky-posts", "--input", "/tmp/in.json"], /--input belongs to family 'discover'/],
  ])("refuses family-specific argument mismatch %j", (args, message) => {
    expect(() => resolveResourceCommandFamily(args as string[])).toThrow(message as RegExp);
  });

  it("refuses a family form that is missing its own required argument", () => {
    expect(() => resolveResourceCommandFamily(["discover"])).toThrow(/discover requires --input/);
    expect(() => resolveResourceCommandFamily(["discover", "--input"])).toThrow(/discover requires --input/);
    expect(() => resolveResourceCommandFamily(["crawl", "--db", "/tmp/c.sqlite"])).toThrow(/crawl requires --source/);
    expect(() => resolveResourceCommandFamily(["crawl", "--source", "musicbrainz"])).toThrow(/crawl requires --db/);
  });

  it("refuses canon with a source that is not the canon source", () => {
    expect(() => resolveResourceCommandFamily(["canon", "--source", "musicbrainz"])).toThrow(
      /canon requires --source bitcoin-canon/,
    );
  });

  it("refuses places with any --source", () => {
    expect(() => resolveResourceCommandFamily(["places", "--source", "btcmap-places"])).toThrow(
      /--source does not apply to family 'places'/,
    );
  });
});
