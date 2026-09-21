# Kimi standalone web research

Jeb uses Kimi's standalone REST tools for web research while keeping the reason role keyless with respect to Pubky signing.

## Routing

- `pro` is the default for factual and current-events questions. Evidence includes title, URL, site, date, authority level, and ranked passages.
- `basic` returns source cards when passages are unnecessary.
- `fetch` reads a specific URL only after that exact URL was returned by an earlier search in the same mention.
- Search or fetch failures return `web search unavailable`. Jeb never invents a source.

All provider requests are pinned to `https://api.moonshot.ai`. Redirects are rejected. Queries, passages, and fetched content are treated as untrusted input and pass through the existing screening path before model use.

## Limits and billing

Kimi bills only successful non-empty calls:

| Operation | Default price |
| --- | ---: |
| Basic | $0.002 |
| Pro | $0.003 |
| Fetch | $0.002 |

`JEB_WEB_PER_MENTION_CAP` bounds calls for one mention. `JEB_WEB_DAILY_CEILING` bounds successful billable calls per UTC day. Audit rows contain a query or URL hash, provider operation, result count, duration, and success state; they never contain query text, page content, or credentials.

At the defaults of two calls per mention and 200 successful calls per day, the maximum standalone-tool fee is $0.60/day if every call is Pro. Model token costs remain under the existing token budgets.

## Configuration contract

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `JEB_MODEL_API_KEY` | Yes when enabled | none | Existing Kimi platform credential |
| `JEB_WEB_PROVIDER` | No | `kimi` | `kimi`, `brave`, or `off`; legacy `moonshot` maps to `kimi` |
| `JEB_WEB_TIMEOUT_MS` | No | `30000` | Client and provider timeout, capped at 60 seconds |
| `JEB_WEB_PER_MENTION_CAP` | No | `2` | Maximum provider calls for one mention |
| `JEB_WEB_DAILY_CEILING` | No | `200` | Maximum successful billable calls per UTC day |
| `JEB_WEB_ALLOWED_AUTHORITIES` | No | `S,A,B` | Kimi source authority levels accepted into evidence |
| `JEB_WEB_FETCH_MAX_CHARS` | No | `12000` | Maximum fetched Markdown exposed to the reason role |
| `JEB_WEB_PRICE_BASIC_USD` | No | `0.002` | Cost accounting rate |
| `JEB_WEB_PRICE_PRO_USD` | No | `0.003` | Cost accounting rate |
| `JEB_WEB_PRICE_FETCH_USD` | No | `0.002` | Cost accounting rate |

No signing key, mnemonic, Pubky session, or homeserver write capability is added to the reason role.

## Staging Nexus stall workaround

`nexus.staging.pubky.app` is externally operated and can stop advancing while the staging homeserver remains healthy. Before blaming Jeb, compare the newest stream `indexed_at` with the smoke post time and read the smoke post directly from homeserver public storage.

When Nexus has not indexed a real homeserver post:

1. Keep an organic Nexus watch bounded to 45 minutes.
2. Use the operator ingest path to submit the post's real notification and homeserver-read `PostView` to the deployed staging reason pipeline. `requeue --mention` is sufficient only when Nexus can already fetch the post; otherwise use the contract harness's real-notification seam.
3. Preserve the normal reason and publisher processes. The operator process must use `reasonChildEnv`, strip signing and signup material, and inject only the missing Nexus post read.
4. Require a homeserver-readable reply URI plus matching `handled_mentions`, `web_queries`, and `evidence` rows. A direct Search Pro call alone is not an end-to-end release proof.
5. Do not merge or deploy production unless either the operator journey succeeds or organic Nexus indexing recovers.
