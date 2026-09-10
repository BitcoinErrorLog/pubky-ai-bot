import { describe, expect, it } from "vitest";
import { parseFeedProposal, parseFeedProposalV2 } from "./feed.js";

const OWNER = "n9fzu63meroxfcxccz1budmqbn3e7yj97cy6jjyyoqpamacyod8y";

function proposal(overrides: Record<string, unknown> = {}) {
  return {
    schema: "pubchi-feed-proposal",
    version: 2,
    bot: OWNER,
    owner: OWNER,
    generated_at: 1_760_000_000,
    mode: "create",
    target_feed_id: null,
    feed: {
      name: "Bitcoin",
      icon: "bitcoin",
      feed: {
        tags: ["bitcoin"],
        domain_tags: ["bitcoin"],
        reach: "all",
        sort: "recent",
        layout: "columns",
        content: "short",
      },
    },
    mapping: { status: "exact", unmapped: [] },
    warnings: [],
    installed_user_feed_id: null,
    ...overrides,
  };
}

describe("FeedProposalV2", () => {
  it("accepts a strict create proposal and version-dispatches", () => {
    expect(parseFeedProposalV2(proposal()).ok).toBe(true);
    expect(parseFeedProposal(proposal()).ok).toBe(true);
  });

  it("accepts followers reach when it is explicitly mapped as unsupported", () => {
    expect(parseFeedProposalV2(proposal({
      feed: { ...(proposal().feed as object), feed: { ...(proposal().feed as { feed: object }).feed, reach: "followers" } },
      mapping: {
        status: "adjusted",
        unmapped: [{ request: "followers only", reason: "followers_not_authorable", suggestion: "friends" }],
      },
    })).ok).toBe(true);
  });

  it("rejects unknown content without an explicit mapping", () => {
    expect(parseFeedProposalV2(proposal({
      feed: { ...(proposal().feed as object), feed: { ...(proposal().feed as { feed: object }).feed, content: "unknown" } },
    })).ok).toBe(false);
  });

  it("rejects created_at in the proposal draft", () => {
    expect(parseFeedProposalV2(proposal({
      feed: { ...(proposal().feed as object), created_at: 1_760_000_000 },
    })).ok).toBe(false);
  });
});
