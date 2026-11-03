import { mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { nlqResult } from "@pubky/bot-kit";
import { runAsk } from "./ask.js";
import { resolveThreadNames, shortKey } from "./thread-names.js";
import { mapScoutThreadPost } from "../bot-kit/scout/tools.js";
import { threadDownTemplate, threadUpTemplate } from "../bot-kit/scout/templates.js";
import { TEST_NOW, TEST_OWNER, countingBrain, testTenant } from "./test-helpers.js";

const OTHER = "n9fzu63meroxfcxccz1budmqbn3e7yj97cy6jjyyoqpamacyod8y";
const THIRD = "wzggsym1558jc1d5k6nd5o33rpj5wefypemb1na1niwytbnrm9qy";
const URI = `pubky://${TEST_OWNER}/pub/pubky.app/posts/0035NV17R994G`;
const REPLY_URI = `pubky://${OTHER}/pub/pubky.app/posts/0035NV17R995H`;

function threadNlq(results: unknown[]) {
  return nlqResult({
    outcome: "ok",
    reason: "ok",
    intent: "summarize_thread",
    planned: [{ tool: "scout_get_thread", args: { uri: URI } }],
    results,
  });
}

async function ask(posts: unknown[], summary: string, nexus?: Record<string, unknown>) {
  const out = await runAsk({
    tenant: testTenant(),
    body: { question: `summarize this thread ${URI}` },
    now: TEST_NOW,
    runId: "run-thread-names",
    nlq: async () => threadNlq([{ posts }]),
    nlqOpts: {} as never,
    nexus: nexus as never,
    brain: countingBrain(() => JSON.stringify({ summary })).brain,
  });
  if (!out.ok) throw new Error("ask failed");
  return out.result;
}

describe("thread evidence names", () => {
  it("maps the Scout tagger name join onto the thread row", () => {
    const mapped = mapScoutThreadPost({
      author_id: TEST_OWNER,
      author_name: "Ada",
      post_id: "0035NV17R994G",
      content: "Main claim",
      labels: ["builder"],
      taggers: [OTHER, THIRD],
      tagger_profiles: [{ id: OTHER, name: "Grace" }, { id: THIRD, name: null }, { id: null, name: null }],
      direction: "up",
    }, 12);
    expect(mapped.tagger_names).toEqual({ [OTHER]: "Grace" });
  });

  it("joins tagger names in both thread queries", () => {
    expect(threadUpTemplate("0035NV17R994G", 3, 40).cypher).toContain("collect(DISTINCT {id: tg.id, name: tg.name}) AS tagger_profiles");
    expect(threadDownTemplate("0035NV17R994G", 3, 40).cypher).toContain("AS tagger_profiles");
  });

  it("renders author and tagger names from Scout rows in sources and for the brain", async () => {
    const result = await ask([
      { author_id: TEST_OWNER, author_name: "Ada", uri: URI, content: "Main claim", taggers: [OTHER], tagger_names: { [OTHER]: "Grace" } },
      { author_id: OTHER, author_name: "Grace", uri: REPLY_URI, content: "Reply", taggers: [] },
    ], "Ada made the claim and Grace replied.");
    expect(result.evidence.map((e) => e.label)).toEqual(["Ada — Main claim", "Grace — Reply"]);
    expect(result.summary).toContain("In this thread, Ada made the claim");
    expect(result.summary).not.toContain(TEST_OWNER);
  });

  it("looks up names through Nexus when the row has none and falls back to the short key", async () => {
    const userDetails = vi.fn(async (id: string) => (id === OTHER ? { id, name: "Grace" } : null));
    const posts = [
      { author_id: TEST_OWNER, uri: URI, content: "Main claim", taggers: [OTHER, THIRD] },
    ];
    const resolved = await resolveThreadNames(posts, userDetails, () => 20_000);
    expect(resolved.posts[0]?.author_name).toBe("");
    expect(resolved.posts[0]?.tagger_names).toEqual({ [OTHER]: "Grace" });
    expect(userDetails).toHaveBeenCalledTimes(3);

    const result = await ask(posts, `${shortKey(TEST_OWNER)} made the claim and Grace tagged it.`, { userDetails });
    expect(result.evidence[0]?.label).toBe(`${shortKey(TEST_OWNER)} — Main claim`);
    expect(result.evidence[0]?.label).not.toContain(TEST_OWNER);
    expect(result.evidence[0]?.claimants).toEqual([OTHER, THIRD]);
  });

  it("uses the Nexus name for a nameless author", async () => {
    const userDetails = vi.fn(async (id: string) => ({ id, name: id === TEST_OWNER ? "Ada" : "Grace" }));
    const result = await ask(
      [{ author_id: TEST_OWNER, uri: URI, content: "Main claim", taggers: [OTHER] }],
      "Ada made the claim.",
      { userDetails },
    );
    expect(result.evidence[0]?.label).toBe("Ada — Main claim");
  });

  it("writes before/after fixture output when EVIDENCE_OUT is set", async () => {
    const out = process.env.EVIDENCE_OUT;
    if (!out) return;
    const userDetails = vi.fn(async (id: string) => (id === OTHER ? { id, name: "Grace" } : null));
    const result = await ask(
      [
        { author_id: TEST_OWNER, uri: URI, content: "Main claim", taggers: [OTHER, THIRD] },
        { author_id: OTHER, author_name: "Grace", uri: REPLY_URI, content: "Reply", taggers: [] },
      ],
      "Summary.",
      { userDetails },
    );
    mkdirSync(out, { recursive: true });
    writeFileSync(`${out}/evidence.json`, JSON.stringify({ keys: { author: TEST_OWNER, grace: OTHER, nameless: THIRD }, evidence: result.evidence }, null, 2));
  });
});
