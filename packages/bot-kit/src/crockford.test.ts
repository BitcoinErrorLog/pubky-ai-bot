import { describe, expect, it } from "vitest";
import {
  decodeCrockfordId,
  encodeCrockfordId,
  postIdFromUnixMs,
  postTimestampMs,
  timestampMsFromPostId,
} from "./crockford.js";

describe("crockford post ids", () => {
  it("round-trips 8 zero bytes as 13 zeros", () => {
    expect(encodeCrockfordId(new Uint8Array(8))).toBe("0000000000000");
    expect([...decodeCrockfordId("0000000000000")!]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("round-trips a 2026 timestamp through the post id", () => {
    const ms = Date.parse("2026-09-02T12:00:00.000Z");
    const id = postIdFromUnixMs(ms);
    expect(id).toHaveLength(13);
    expect(id).toMatch(/^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]+$/);
    expect(timestampMsFromPostId(id)).toBe(ms);
    expect(decodeCrockfordId(id)).toHaveLength(8);
  });

  it("rejects U (not in Crockford) and wrong lengths", () => {
    expect(decodeCrockfordId("UUUUUUUUUUUUU")).toBeNull();
    expect(decodeCrockfordId("short")).toBeNull();
    expect(timestampMsFromPostId("WEEKLYCLI0001")).toBeNull();
  });

  it("maps I/L to 1 and O to 0", () => {
    expect([...decodeCrockfordId("000000000000I")!]).toEqual([...decodeCrockfordId("0000000000001")!]);
    expect([...decodeCrockfordId("000000000000O")!]).toEqual([...decodeCrockfordId("0000000000000")!]);
  });

  it("rejects an id timestamp that diverges from indexed_at by more than 1h", () => {
    const created = Date.parse("2026-09-03T10:00:00.000Z");
    const id = postIdFromUnixMs(created);
    const ts = postTimestampMs({
      postId: id,
      indexedAt: Date.parse("2026-08-01T00:00:00.000Z"),
      createdAt: Date.parse("2026-08-02T00:00:00.000Z"),
    });
    expect(ts).toBeNull();
  });

  it("keeps the id timestamp when indexed_at is within 1h", () => {
    const created = Date.parse("2026-09-03T10:00:00.000Z");
    const id = postIdFromUnixMs(created);
    const ts = postTimestampMs({
      postId: id,
      indexedAt: created + 30 * 60 * 1000,
    });
    expect(ts).toBe(created);
  });

  it("falls back to created_at then indexed_at when the id is not a timestamp", () => {
    expect(
      postTimestampMs({ postId: "TAGFEED000001", createdAt: 1_700, indexedAt: 1_600 }),
    ).toBe(1_700);
    expect(postTimestampMs({ postId: "TAGFEED000001", indexedAt: 1_600 })).toBe(1_600);
    expect(postTimestampMs({ postId: "TAGFEED000001" })).toBeNull();
  });
});
