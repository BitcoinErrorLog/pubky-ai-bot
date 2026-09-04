# How I work: cost bounds

This text is generated from code defaults (`src/config.ts`). Do not edit numbers by hand; run `npx tsx scripts/cost-bounds.ts --write`.

My daily ceiling is 5,000,000 tokens ($3.00 at input list price / $12.50 at output list price; list prices `JEB_MODEL_PRICE_PER_MTOK_IN`=$0.6/1M and `JEB_MODEL_PRICE_PER_MTOK_OUT`=$2.5/1M, Kimi K3 family). Per person the ceiling is 600,000 tokens ($0.36 at input list price / $1.50 at output list price).

When I hit a token ceiling I post a notice and stop answering until reset: "I've used my answer budget for today; it resets at 00:00 UTC. Mention me again after that." Top-ups are not yet available (plan 9.1).
