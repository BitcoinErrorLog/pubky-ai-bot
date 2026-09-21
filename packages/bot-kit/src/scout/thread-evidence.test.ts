import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { postViewSchema } from "../nexus-schema.js";
import { threadDownTemplate, threadUpTemplate } from "./templates.js";
import {
  attachmentUrls,
  dedupeThreadPosts,
  fillEmptyThreadPosts,
  mapScoutThreadPost,
  threadPostFromNexus,
} from "./tools.js";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const TEXT_CAPTURE = JSON.parse(readFileSync(join(FIXTURE_DIR, "nexus-post-text.json"), "utf8")) as {
  captured_at: string;
  host: string;
  path: string;
  body: unknown;
};
const IMAGE_CAPTURE = JSON.parse(readFileSync(join(FIXTURE_DIR, "nexus-post-image.json"), "utf8")) as {
  captured_at: string;
  host: string;
  path: string;
  body: unknown;
};

describe("thread Cypher templates", () => {
  it("unwinds a single root row instead of duplicating the leaf", () => {
    const up = threadUpTemplate("0035QYMGGEM7G", 3, 40);
    const down = threadDownTemplate("0035QYMGGEM7G", 3, 40);
    expect(up.cypher).toContain("[:REPLIED*1..3]");
    expect(up.cypher).not.toMatch(/REPLIED\*0/);
    expect(up.cypher).toContain("UNWIND ([leaf] + ancs) AS p");
    expect(up.cypher).not.toContain("ancs + [leaf]");
    expect(up.cypher).toContain("WITH DISTINCT p");
    expect(up.cypher).toContain("p.attachments AS attachments");
    expect(down.cypher).toContain("[:REPLIED*1..3]");
    expect(down.cypher).not.toMatch(/REPLIED\*0/);
    expect(down.cypher).toContain("WITH DISTINCT p");
    expect(down.cypher).not.toContain("[leaf]");
  });
});

describe("thread post mapping", () => {
  it("dedupes concatenated up/down rows that share a post id", () => {
    const row = {
      author_id: "wzggsym1558jc1d5k6nd5o33rpj5wefypemb1na1niwytbnrm9qy",
      author_name: "Ada",
      post_id: "0035QYMGGEM7G",
      content: "Coding is solved.",
      indexed_at: 1,
      labels: [],
      taggers: [],
      direction: "up",
    };
    const posts = dedupeThreadPosts([
      mapScoutThreadPost({ ...row, direction: "up" }, 12),
      mapScoutThreadPost({ ...row, direction: "down" }, 12),
    ]);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.uri).toContain("0035QYMGGEM7G");
  });

  it("parses Scout JSON-encoded attachment URLs without rewriting content", () => {
    const file = "pubky://gi169rgooxb3mza8j9uf1xoqjacakgwp4za1dz1hgghbhet4m86y/pub/pubky.app/files/0035QYQSVNDAG";
    const mapped = mapScoutThreadPost({
      author_id: "gi169rgooxb3mza8j9uf1xoqjacakgwp4za1dz1hgghbhet4m86y",
      post_id: "0035QYQSVNK60",
      content: "",
      attachments: JSON.stringify([file]),
      taggers: [],
      labels: [],
    }, 12);
    expect(mapped.content).toBe("");
    expect(attachmentUrls(mapped.attachments)).toEqual([file]);
  });
});

describe("Scout-empty Nexus fallback", () => {
  it("fills readable text from the captured Nexus post body", async () => {
    expect(TEXT_CAPTURE.host).toBe("nexus.pubky.app");
    const view = postViewSchema.parse(TEXT_CAPTURE.body);
    const posts = await fillEmptyThreadPosts([], view.details.uri, async () => view);
    expect(posts).toHaveLength(1);
    expect(String(posts[0]?.content)).toContain("Coding is solved.");
    expect(posts[0]?.uri).toBe(view.details.uri);
  });

  it("keeps Scout names and cites captured attachment URLs", async () => {
    const view = postViewSchema.parse(IMAGE_CAPTURE.body);
    const fromNexus = threadPostFromNexus(view);
    expect(fromNexus.attachments).toEqual(view.details.attachments);
    const posts = await fillEmptyThreadPosts(
      [{
        uri: view.details.uri,
        author_id: view.details.author,
        author_name: "Ada",
        content: "",
        taggers: [view.details.author],
      }],
      view.details.uri,
      async () => view,
    );
    expect(posts).toHaveLength(1);
    expect(posts[0]?.author_name).toBe("Ada");
    expect(posts[0]?.content).toBe(view.details.content);
    expect(posts[0]?.attachments).toEqual(view.details.attachments);
    expect(posts[0]?.taggers).toEqual([view.details.author]);
  });

  it("leaves Scout rows unchanged when Nexus is missing", async () => {
    const uri = "pubky://wzggsym1558jc1d5k6nd5o33rpj5wefypemb1na1niwytbnrm9qy/pub/pubky.app/posts/0035QYMGGEM7G";
    const posts = await fillEmptyThreadPosts([{ uri, content: "" }], uri, async () => null);
    expect(posts).toEqual([{ uri, content: "" }]);
  });
});
