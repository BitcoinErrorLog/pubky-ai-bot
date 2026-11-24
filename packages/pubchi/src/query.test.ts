import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { socialUserTagsSchema } from "../bot-kit/nexus-schema.js";
import { assembleQueryResult, runQuery } from "./query.js";
import { TEST_OWNER, TEST_NOW, testTenant, happyNlqResult } from "./test-helpers.js";

const tagger = "93cmekqb6dgpq1up5rkhmcgfacdskxmefn3qxp9fswcwagz3bt1o";
const fixture = socialUserTagsSchema.parse(JSON.parse(
  readFileSync(new URL("./__fixtures__/nexus-user-tags.fgp3.json", import.meta.url), "utf8"),
));
const emptyFixture = JSON.parse(
  readFileSync(new URL("./__fixtures__/nexus-user-tags.empty.json", import.meta.url), "utf8"),
) as Awaited<ReturnType<NonNullable<Parameters<typeof runQuery>[0]["nexus"]>["userTags"]>>;

function opts(overrides: Partial<Parameters<typeof runQuery>[0]> = {}) {
  const nlq = vi.fn(async () => {
    throw new Error("NLQ must not be called");
  });
  const tenant = testTenant({ owner: "fgp3fnesafwnp3eb9hq6xfb8p3i8cqnh5awyjsoe6uqas3pautzy" });
  return {
    tenant,
    body: { question: "who tagged me?", asker: TEST_OWNER },
    now: TEST_NOW,
    runId: "run-test",
    nlq,
    nlqOpts: {} as never,
    nexus: { userTags: async () => fixture },
    ...overrides,
  };
}

describe("who-tagged-me Nexus path", () => {
  it("maps v1 tag rows to stable QueryResultV1 items", async () => {
    const input = opts();
    const out = await runQuery(input);
    expect(out).toMatchObject({
      ok: true,
      result: {
        items: [
          {
            label: "ai-bot-test",
            source_uri: `pubky://${tagger}/pub/social/v1/profile.json`,
            subject_uri: "pubky://fgp3fnesafwnp3eb9hq6xfb8p3i8cqnh5awyjsoe6uqas3pautzy/pub/social/v1/profile.json",
            claimant_count: 1,
          },
          {
            label: "pubchi",
            source_uri: `pubky://${tagger}/pub/social/v1/profile.json`,
            subject_uri: "pubky://fgp3fnesafwnp3eb9hq6xfb8p3i8cqnh5awyjsoe6uqas3pautzy/pub/social/v1/profile.json",
            claimant_count: 1,
          },
          {
            label: "testing",
            source_uri: `pubky://${tagger}/pub/social/v1/profile.json`,
            subject_uri: "pubky://fgp3fnesafwnp3eb9hq6xfb8p3i8cqnh5awyjsoe6uqas3pautzy/pub/social/v1/profile.json",
            claimant_count: 1,
          },
        ],
        tool_trace_summary: { tools: ["nexus_user_tags"], call_count: 1, truncated: false },
      },
    });
    expect(input.nlq).not.toHaveBeenCalled();
  });

  it("keeps valid taggers when a row contains a malformed owner key", async () => {
    const invalid = "a".repeat(52);
    const out = await runQuery(opts({
      nexus: { userTags: async () => [{ label: "test", taggers: [invalid, tagger], taggers_count: 2, relationship: false }] },
    }));
    expect(out).toMatchObject({ ok: true, result: { items: [
      { label: "test", source_uri: `pubky://${tagger}/pub/social/v1/profile.json`, claimant_count: 2 },
    ] } });
  });

  it("returns a valid empty result for the empty fixture", async () => {
    const out = await runQuery(opts({ nexus: { userTags: async () => emptyFixture } }));
    expect(out).toMatchObject({
      ok: true,
      result: { items: [], tool_trace_summary: { tools: ["nexus_user_tags"], call_count: 1 } },
    });
  });

  it("maps Nexus 500 without leaking upstream body text", async () => {
    const out = await runQuery(
      opts({
        nexus: {
          userTags: async () => {
            const error = new Error("secret upstream response body") as Error & { status: number };
            error.status = 500;
            throw error;
          },
        },
      }),
    );
    expect(out).toMatchObject({
      ok: false,
      code: "UPSTREAM_UNAVAILABLE",
      stage: "upstream",
      cause: "nexus_user_tags 500",
    });
    expect(out).toHaveProperty("timings.nexus_ms", expect.any(Number));
    expect(JSON.stringify(out)).not.toContain("secret upstream response body");
  });

  it("maps Nexus schema drift to upstream unavailable", async () => {
    const out = await runQuery(opts({
      nexus: { userTags: async () => { throw Object.assign(new Error("schema mismatch"), { zodIssueCount: 2 }); } },
    }));
    expect(out).toMatchObject({ ok: false, code: "UPSTREAM_UNAVAILABLE", stage: "upstream" });
  });

  it("uses the verified tenant owner and ignores body asker", async () => {
    const userTags = vi.fn(async (owner: string) => {
      expect(owner).toBe("fgp3fnesafwnp3eb9hq6xfb8p3i8cqnh5awyjsoe6uqas3pautzy");
      return fixture;
    });
    const out = await runQuery(opts({ nexus: { userTags }, body: { asker: TEST_OWNER } }));
    expect(out.ok).toBe(true);
    expect(userTags).toHaveBeenCalledWith("fgp3fnesafwnp3eb9hq6xfb8p3i8cqnh5awyjsoe6uqas3pautzy");
  });
});

it("accepts only public Social v1 landscape subjects owned by the tenant", () => {
  const tenant = testTenant();
  const subject = `pubky://${tenant.owner}/pub/social/v1/posts/00321FCW75ZFY`;
  const uris = [
    subject,
    subject.replace(tenant.owner, tagger),
    subject.replace("/pub/", "/priv/"),
    subject.replace("/pub/social/v1/", "/pub/pubky.app/"),
  ];
  const result = assembleQueryResult({
    tenant, now: TEST_NOW, runId: "test-landscape",
    nlq: {
      ...happyNlqResult(tenant.owner),
      results: [{ applications: uris.map((uri) => ({ uri, tagger_id: tagger })), claims: [{ label: "bitcoin", count: 2 }] }],
    },
  });
  expect(result.items).toEqual([{
    label: "bitcoin", claimant_count: 2, subject_uri: subject, source_uri: `pubky://${tagger}/pub/social/v1/profile.json`,
  }]);
});
