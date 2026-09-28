import { describe, expect, it } from "vitest";
import { claimPublish } from "./publish-store.js";

describe("publish persona snapshot propagation", () => {
  it("claims the immutable snapshot through the evidence reference", async () => {
    let sql = "";
    const snapshot = { id: "jeb", version: "1.0.0", hash: "a".repeat(64) };
    const db = {
      query: async (text: string) => {
        sql = text;
        return {
          rowCount: 1,
          rows: [{
            id: "1",
            mention_key: "mention",
            parent_uri: "pubky://parent",
            content: "answer",
            evidence_id: "9",
            attempts: 1,
            fail_first_attempt: false,
            scrubbed: false,
            replace_post_id: null,
            standalone: false,
            post_kind: null,
            attachments: null,
            collection_id: null,
            approved_by: null,
            categories: [],
            persona_snapshot: snapshot,
          }],
        };
      },
    };
    const row = await claimPublish(db, 5);
    expect(sql).toContain("jsonb_array_elements");
    expect(sql).toContain("persona_snapshot");
    expect(row?.persona_snapshot).toEqual(snapshot);
  });
});
