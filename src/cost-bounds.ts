import {
  DEFAULT_DAILY_TOKEN_BUDGET,
  DEFAULT_MODEL_PRICE_PER_MTOK_IN,
  DEFAULT_MODEL_PRICE_PER_MTOK_OUT,
  DEFAULT_USER_DAILY_TOKEN_BUDGET,
} from "./config.js";
import { SKIP_NOTICE_TEXT } from "./skip-notice.js";
import { tokensToUsd } from "./metrics-db.js";

export interface CostBoundsInput {
  dailyTokenBudget: number;
  userDailyTokenBudget: number;
  priceIn: number;
  priceOut: number;
}

export function costBoundsFromDefaults(): CostBoundsInput {
  return {
    dailyTokenBudget: DEFAULT_DAILY_TOKEN_BUDGET,
    userDailyTokenBudget: DEFAULT_USER_DAILY_TOKEN_BUDGET,
    priceIn: DEFAULT_MODEL_PRICE_PER_MTOK_IN,
    priceOut: DEFAULT_MODEL_PRICE_PER_MTOK_OUT,
  };
}

function usdRange(tokens: number, priceIn: number, priceOut: number): string {
  const lo = tokensToUsd(tokens, 0, tokens, priceIn, priceOut);
  const hi = tokensToUsd(0, tokens, tokens, priceIn, priceOut);
  return `$${lo.toFixed(2)} at input list price / $${hi.toFixed(2)} at output list price`;
}

/** Profile "how I work" cost-bounds copy. Numbers come from config defaults, not literals. */
export function generateCostBoundsMarkdown(bounds: CostBoundsInput = costBoundsFromDefaults()): string {
  const dailyUsd = usdRange(bounds.dailyTokenBudget, bounds.priceIn, bounds.priceOut);
  const userUsd = usdRange(bounds.userDailyTokenBudget, bounds.priceIn, bounds.priceOut);
  const notice = SKIP_NOTICE_TEXT.budget;
  return [
    "# How I work: cost bounds",
    "",
    "This text is generated from code defaults (`src/config.ts`). Do not edit numbers by hand; run `npx tsx scripts/cost-bounds.ts --write`.",
    "",
    `My daily ceiling is ${bounds.dailyTokenBudget.toLocaleString("en-US")} tokens (${dailyUsd}; list prices \`JEB_MODEL_PRICE_PER_MTOK_IN\`=$${bounds.priceIn}/1M and \`JEB_MODEL_PRICE_PER_MTOK_OUT\`=$${bounds.priceOut}/1M, Kimi K3 family). Per person the ceiling is ${bounds.userDailyTokenBudget.toLocaleString("en-US")} tokens (${userUsd}).`,
    "",
    `When I hit a token ceiling I post a notice and stop answering until reset: "${notice}" Top-ups are not yet available (plan 9.1).`,
    "",
  ].join("\n");
}
