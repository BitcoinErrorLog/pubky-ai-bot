import { describe, expect, it } from "vitest";
import { parseConversationalPlanForPubchi } from "./conversational-plan.js";

const validFeedPlan = {
  kind: "feed",
  spec: {
    name: "Bitcoin",
    icon: "bitcoin",
    feed: { reach: "all", sort: "recent", layout: "columns" },
  },
};

describe("parseConversationalPlanForPubchi", () => {
  it("re-validates an opaque feed draft with Pubchi schemas", () => {
    expect(parseConversationalPlanForPubchi(validFeedPlan).success).toBe(true);
    expect(parseConversationalPlanForPubchi({
      ...validFeedPlan,
      spec: { ...validFeedPlan.spec, feed: { ...validFeedPlan.spec.feed, layout: "invalid" } },
    }).success).toBe(false);
  });
});
