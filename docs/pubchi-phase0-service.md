# Pubchi Phase 0 service

Read-only hosted Pubchi. Two trust domains only: **Gateway/API** and **Reason/NLQ**. No scheduler, no publisher, no session broker, no bot key.

Process entry: `npm run pubchi` or `node dist/main.js --role pubchi`. `npm run pubchi` runs `node --preserve-symlinks --preserve-symlinks-main --import tsx` so `src/pubchi` → `../bot-kit` resolves through the `src/` symlink tree. `NODE_OPTIONS=--preserve-symlinks` is not used: this repo's `node_modules` is a symlink and that flag breaks the `tsx` `.bin` shim. Compiled `dist/main.js` is unchanged. The public role checks migration state without DDL; the dedicated `node dist/main.js --role pubchi-migrate` mode is the only Pubchi migration executor and exits without HTTP.

`--role pubchi` pins the feed brain to `PHASE0_BRAIN.model_id` (`kimi-k3`). `JEB_MODEL` is ignored for this role so a leftover `gpt-4o-mini` default cannot make every `/v1/feed` fail as `BRAIN_UNAVAILABLE`.

## Staging vs production

Write this down once: **defaults are mixed on purpose.**

| Dependency | Default | Notes |
| --- | --- | --- |
| Nexus (`JEB_NEXUS_URL`) | `https://nexus.staging.pubky.app` | Staging graph/search. Override for production Nexus. |
| Homeserver (`JEB_HOMESERVER`) | unset | Tenant resolution uses Pubky `publicStorage` (pkarr + the asker's homeserver). A local/dev homeserver is fine. |
| Scout (`JEB_SCOUT_URL`) | `https://nexus-scout.pubky.app` | **Production** Scout host. This is not a staging URL. |

Dev/staging Pubchi may therefore read staging Nexus and production Scout at the same time. That is the documented default, not a mislabel.

## Endpoints

| Method | Path | Success | Notes |
| --- | --- | --- | --- |
| `GET` | `/healthz` | `{ ok: true, role: "pubchi", mode: "runtime" }` | Not pre-auth rate limited. |
| `POST` | `/v1/query` | `QueryResultV1` or `PubchiAnswerV1` | Purpose is `who-tagged-me` or `ask`. `who-tagged-me` is deterministic from Nexus user tags for the verified owner (no NLQ, no Scout). `ask` runs NLQ with `asker` forced to the verified owner and interprets graph evidence, never a verdict. |
| `POST` | `/v1/feed` | `FeedProposalV1` or opt-in `FeedProposalV2` | Purpose must be `build-feed`. Brain structured output, then `pubky-app-specs`. `created_at`/`generated_at` are set server-side. Send `body.proposal_version: 2` to opt into V2; omission remains byte-compatible V1. |

Feed generation treats a feed as posts filtered by tags, reach, sort, layout, and
content. Requests for “people tagged X” are translated to posts tagged X, with
that clarification preserved in the proposal name. If the first model response
is invalid, the service makes at most one bounded retry and returns
`FEED_SPECS_INVALID` with `stage: "feed"` and a `cause` of `unsupported_intent`,
`schema`, or `json_parse` when both attempts fail.

### FeedProposalV2 catalog and mapping

V2 is requested in the hashed feed body with `proposal_version: 2`. It is additive:
callers that omit the field receive the existing V1 envelope and behavior. V2 never
writes a feed; the App remains responsible for editing, validating, and applying it.
Update mode is emitted only when the body contains both an App-loaded
`target_feed_id` and `current_feed`; the model cannot choose an identifier.

| Field | Values and limits |
| --- | --- |
| `name` | Required string, max 100 characters |
| `icon` | Required string, max 50 characters |
| `tags` | Optional; max 5 strings, each max 20 characters |
| `domain_tags` | Optional; max 5 strings, each max 20 characters |
| `reach` | `following`, `followers`, `friends`, `all`, `wot`, `me`; `wot` is two hops; `followers` is not authorable by this App |
| `sort` | `recent` or `popularity` (bookmarks, reposts, and replies) |
| `layout` | `columns`, `wide`, `visual`, or `list` |
| `content` | `short`, `long`, `image`, `video`, `link`, `file`, `collection`, or `unknown`; omit for all content |

`mapping.status` is computed after model output: `exact` means all requested values
were represented; `adjusted` means a value was safely changed or a request was
ambiguous; `unsupported` means an unsupported request remains in the proposal.
`mapping.unmapped` preserves each unrepresented request with one of
`likes_unavailable`, `followers_not_authorable`, `unknown_content`, or `ambiguous`,
plus a suggestion. Likes use the exact capability copy: “Feeds can’t filter or sort
by likes because Pubky does not model likes. Closest options: Popularity
(bookmarks/reposts/replies) or Recent.” A proposal containing `followers` reach or
`unknown` content is always flagged and must not be applied by the App.

Request body:

```json
{ "request": { "...RequestObjectV1" }, "body": { "question": "who tagged me?" } }
```

`body` must be present (missing key → `SCHEMA_INVALID`). A missing value is hashed as `null`. `body.asker` / `body.scope` are ignored. The gateway forces `asker = U` and `scope.graph_scope.pubky = U` from the verified request + enrollment.

For `who-tagged-me`, Pubchi reads `GET /v0/user/<verified-owner>/tags` from Nexus
and maps each tagger to the owner's profile URI. This path is deterministic so a
natural-language planner cannot select unrelated Scout tools for a question with
a direct upstream answer. Nexus 404 is an honest empty result; upstream failures
return `UPSTREAM_UNAVAILABLE`.

For `purpose: "ask"`, the body is `{ "question": "..." }` with a trimmed question of 1–500
characters. The response is the strict version-1 `pubchi-answer` schema: it contains a
non-empty interpretation `summary`, up to 50 evidence items, source URIs, and the tool
trace summary. C3 `what did I miss` answers may additionally include `continuation`:
`since` is inclusive, `until` is exclusive and uses the server clock, `complete` reports
whether the source window was complete, and `skipped` counts deleted or unreadable events.
The field is absent for all other routes. Unsupported questions and refusals return HTTP 200 with an empty evidence
array and a plain-language summary. Routing covers graph-shaped requests with typed tools:
follower rankings use `rank_users(metric: followers)`, tag questions use
`get_tag_landscape` or `get_emerging_topics`, topic/thread questions use
`get_topic_brief` or `top_posts`, and follow recommendations, stale follows, paths, and
trust questions use their corresponding graph tools. The asker is supplied as the graph
scope for owner-relative requests.

Graph answers may include the optional strict `scope` field on `PubchiAnswerV1`.
It records the executed time window (`since_ms`, `until_ms`, bounded `label`, and
`source` of `explicit`, `default`, or `tool`), graph kind and optional hop count,
up to ten bounded filters, and whether the result is complete. A no-lookup
conversational answer uses `graph.kind: "none"` when scope is present; the service
does not infer scope from the question after execution.

#### C3 and C4 routes

C3 utterances include `what did I miss`, `catch me up`, and `anything new since yesterday`.
It reads followed-account posts, replies to the owner's posts, and tags on the owner or
owner's posts. Results are capped at 15 posts, 10 replies, and 10 tags, with an `and N
more` count. The window clamps to 30 days; future `since` clamps to `until`, which is
exclusive, and an omitted `since` means the previous 24 hours. Empty windows use a
deterministic no-evidence summary without a brain call. Partial pages or source failures
set `complete=false` while still returning HTTP 200 and the server-clock `until`, so the
App must not advance its cursor; unreadable rows are excluded and counted in `skipped`.

C4 accepts `summarize this thread <ref>`, `summarize <ref>`, and `what's this thread
about <ref>` for `pubky://` post URIs and `pubky.app`/`bots.pubky.app` post URLs. It
returns root-first evidence and asks the brain for the main claim, strongest reply, and
minority position when present. Invalid references are not routed.

#### Routing

Pubchi routes through the deterministic regex router first. When it produces no route,
the model planner may run as a fallback; this is Pubchi-only and never changes Jeb mode.
The fallback receives a catalog rendered from the served tool definitions (purpose and
the live JSON argument schemas), excluding `query_graph` and any tool not registered on
the service. Its strict response is either
`{"tool":"<catalog name>","args":{},"confidence":0..1}` or `{"tool":null}`.
Zod validates the selected tool and rejects unknown tools, arguments, and enum values
before the existing parameterized execution path runs. Invalid JSON, timeout, and
unsupported selections return the honest no-route response. Telemetry records only
`route_source` (`regex`, `model`, or `none`) and the selected tool; question text is
not logged. The fallback adds roughly 1–3 seconds only when regex routing misses.

The brain is called only when screened evidence exists. Its JSON may be prose-wrapped or
fenced, but must contain only `{ "summary": string }`; summaries naming a Pubky absent from
the evidence are rejected. Deterministic summaries receive the same check and fall back
when rejected. If output is invalid, times out, or errors, Pubchi returns a
deterministic summary from the screened evidence. With no evidence, it names the lookup
that was attempted and suggests actionable rephrasings without claiming facts. The
`pubchi_ask` log records `summary_source` as `deterministic`, `deterministic_rejected`, `brain`,
`fallback_invalid_json`, `fallback_empty`, `fallback_brain_error`, `fallback_timeout`,
or `skipped_no_evidence`, or `no_route`. `summary_source` is telemetry only and is
not part of the frozen response schema. When no typed tool matches, the response
keeps an empty tool trace, settles one token, and names the supported graph lookups.
Structured homogeneous routes use deterministic summaries: `nexus_influencers` and
follower `rank_users` map to follower counts, tag-ranking `rank_users` maps to the
selected tag count, `tag_landscape` to tag claimant counts,
`recommend` to mutual-follower counts, `stale_follows` to inactive accounts,
and `top_posts` to authors and reply counts. Mixed or heterogeneous routes
continue to use the brain. The App should map `tool_trace_summary.tools` to evidence
labels as follows: planned `nexus_influencers` (trace `nexus_influencer`) and
follower `rank_users` (trace `rank_users`) → “Followers”; tag-received
`rank_users` (trace `rank_tags_recv`) → “Tags received”; tag-applied `rank_users`
(trace `rank_tags_apply`) → “Tags applied”; planned `get_tag_landscape` (trace
`tag_landscape`) → “Tagged by”; planned `recommend_follows` (trace `recommend`) →
“Claimants”;
`top_posts` → “Replies”; `stale_follows` → “Claimants”; and all other tools →
“Claimants”. Post evidence labels shown by the App use the format
`<author_name> — <excerpt> [<up to three tag labels>]` when the labels fit
within the evidence label cap; otherwise the labels are omitted. The excerpt
is whitespace-collapsed and screened post content.

Canonical App quick-question utterances:

| Route | Utterance |
| --- | --- |
| who-tagged-me | `Who tagged me?` |
| influencers | `Who are the most followed users on Pubky?` |
| rank_users (`tags_received`) | `Who has the most tags?` |
| rank_users (`tags_applied`) | `Who are the top taggers?` |
| top_posts | `What are the most active threads right now?` |
| emerging_topics | `What tags are trending this week?` |
| recommend_follows | `Who should I follow?` |
| stale_follows | `Which accounts I follow have gone quiet?` |
| get_what_changed | `What changed in my network this week?` |
| build-feed | `Build me a feed.` |

### Owner context

Owner context is stored privately at `/priv/pubchi.app/context.json`, behind the owner's
homeserver access control. The App reads it with the user's session and delivers it inside a
signed request field defined by the version-2 request-object design. The keyless service is
stateless with respect to this context: it does not store or log the text. Telemetry records
only context lengths and a rejection reason.

The context shape is `{ about?: string, instructions?: string }`. `about` is capped at 1,500
characters and `instructions` at 1,000 characters. Secret-shaped values and Pubky identifiers
are rejected and dropped; imperative text is screened as untrusted input. The rendered block is
capped at 2,600 characters and is delimited with `<owner_context>` and `</owner_context>`.
System rules (evidence-only, no verdict words, no Pubkys absent from evidence, and a 1,200
character answer limit) take precedence over owner context, which takes precedence over
evidence. Owner context may steer interpretation, emphasis, language, and tone, but may not add
facts. The service rollout precedes the App mirror and request-object v2 delivery.

### Request v2

Request v2 is accepted alongside v1 during migration. Its strict signed object contains
`schema: "pubchi-request-object-v2"`, `version: 2`, normalized `audience`, `asker`,
optional `signer`, `bot`, `key_generation`, one of `ask`, `who-tagged-me`, or `build-feed`,
`body_sha256`, `issued_at`, `expires_at`, `nonce`, optional signed `context`, and
`signature`. Canonical form is UTF-8 JSON with recursively sorted object keys, no whitespace,
and undefined fields omitted; the signature covers every unsigned field.

The verifier checks body/schema, signature, audience, route/purpose, then tenant
or delegation read. It resolves tenant and delegation, enforces the cutover-based
delegation lifetime for both v1 and v2, consumes the shared nonce, reserves owner and
per-signer budgets, and then runs the handler. `PUBCHI_AUDIENCE_ORIGINS` is a required
comma-separated list of normalized
HTTPS API deployment origins; the first is canonical and requests may name any listed
origin. It is independent from `PUBCHI_ALLOWED_ORIGINS`, which controls browser CORS.
The App derives `audience` from the origin of its configured Pubchi API URL.
`PUBCHI_V1_SUNSET` is an ISO timestamp after which v1
returns `VERSION_UNSUPPORTED`; the App emits v2 only and never retries as v1.

Delegations created at or after `PUBCHI_DELEGATION_CAP_AT` are limited to seven days.
A delegation created before cutover may be backdated to just before the cutover and
retain a lifetime of at most 30 days until `PUBCHI_DELEGATION_CAP_AT + 30 days`;
after that bounded grandfather window, the seven-day rule is universal. A delegation
whose expiry exceeds that window is rejected.

Scout mention keys are logged as HMAC pseudonyms, using `PUBCHI_LOG_HASH_KEY` when
configured. If unset, a random per-process key is used; pseudonyms are linkable only
within that key lifetime and are not a substitute for access control.

The verifier order is **body parse/schema → signature → audience → route↔purpose →
tenant → delegation → nonce → budget**. The route↔purpose check runs before any
tenant or delegation read and returns `PURPOSE_UNSUPPORTED` without revealing
tenant or delegation state. The service resolves the bot from the owner's
state and preserves the request-bot check before the delegation decision.
Nonce consumption remains after tenant and delegation authorization.

Errors are `{ "error": "<CODE>" }` only. Whitelisted codes:

- Schema/verifier: `SCHEMA_INVALID`, `VERSION_UNSUPPORTED`, `UNKNOWN_FIELD`, `FORBIDDEN_*`, `INVALID_PUBKY`, `TIER_UNSUPPORTED`, `BRAIN_FORBIDDEN`, `BUDGET_NOT_FIXED`, `FEED_SPECS_INVALID`, `FEED_UNSUPPORTED_LIKES`, `FEED_UNSUPPORTED_REACH`, `REQUEST_MALFORMED`, `SIGNATURE_INVALID`, `REQUEST_EXPIRED`, `CLOCK_SKEW`, `NONCE_REPLAY`, `BODY_HASH_MISMATCH`, `ASKER_MISMATCH`, `BOT_MISMATCH`, `PURPOSE_UNSUPPORTED`, `PATH_FORBIDDEN`, `URI_FORBIDDEN`
- Service: `TENANT_NOT_ENROLLED`, `BUDGET_EXCEEDED`, `RATE_LIMITED`, `UPSTREAM_UNAVAILABLE`, `BRAIN_UNAVAILABLE`

HTTP status: `200` success; `400` most verify/schema failures; `404` `TENANT_NOT_ENROLLED`; `429` `BUDGET_EXCEEDED` / `RATE_LIMITED`; `503` `UPSTREAM_UNAVAILABLE` / `BRAIN_UNAVAILABLE`.

Every non-2xx response logs **one** pino line at level 40 (`warn`) with `code`, `stage` (`verify` | `tenant` | `query` | `feed` | `upstream`), `status`, and a sanitized `cause` (no prompt text, no keys). Upstream call failures also include `upstream_host` (host[:port]) and `upstream_status`. Tenant resolution does not log on its own.

### CORS

Browser callers (Pubky App on `http://localhost:3001`) need an explicit origin allowlist. Set `PUBCHI_ALLOWED_ORIGINS` to a comma-separated list of exact origins.

| Request | Allowlisted `Origin` | Unknown `Origin` or empty env |
| --- | --- | --- |
| `OPTIONS` preflight | `204` + `Access-Control-Allow-Origin: <that origin>`, `Vary: Origin`, `Access-Control-Allow-Methods: POST, OPTIONS`, `Access-Control-Allow-Headers: content-type, accept`, `Access-Control-Max-Age: 600` | `204` with **no** ACAO headers (browser blocks; this is not auth) |
| `POST` success or error | same `Access-Control-Allow-Origin` + `Vary: Origin` | no CORS headers; the handler still runs |

Never `*`. Never reflect an unknown origin. Never `Access-Control-Allow-Credentials`. Empty / unset `PUBCHI_ALLOWED_ORIGINS` sends no CORS headers at all (server-to-server). App `fetch` sends `content-type` and `accept`.

## Trust domains

Present in Phase 0:

1. **Gateway/API** — bind, body cap, timeout, pre-auth rate limit, request-object verify, tenant resolve, token bucket, response codes. No session, no provider key in this module.
2. **Reason/NLQ** — Bot Kit NLQ (`asker` forced), Scout budgets keyed `pubchi:<U>` (owner only), brain via `createBrain({ id, model: PHASE0_BRAIN.model_id, ... })` from `JEB_BRAIN` / `JEB_MODEL_*`. A brain error is `BRAIN_UNAVAILABLE`. No fallback. Redirects on the model HTTP path are refused so `Authorization` cannot leave the allowlisted host.

Absent until later phases: scheduler, publisher, session broker, homeserver PUT,
`PUBKY_BOT_SECRET_KEY*`, and bot write credentials. Budgets remain keyed by owner,
not bot.

Tenant resolution uses public GETs through Pubky `publicStorage` (no session,
5 s timeout), keyed and cached by owner U:

The canonical, binding, config, and signer-delegation reads share one per-owner
fetch bucket: at most 24 homeserver GETs immediately, then 30 more per 60 seconds.
Thus a signed request that misses both caches is bounded by the remaining owner
budget, never by the attacker's supply of rotated signers.

1. Read `pubky://U/pub/pubchi.app/bot.json` and derive canonical bot B and
   `key_generation`.
2. Require the signed request to name B. A different request bot is rejected
   before any binding or delegation read and is opaque `UNAUTHORIZED` to
   signer-bearing callers.
3. Read `pubky://U/pub/pubchi.app/bots/<B>.json`; require an active binding and
   the same generation.
4. Read `pubky://U/pub/pubchi.app/config.json`. A 404 selects the read-only
   default. Other read/parse failures fail closed.
5. Compute the effective tier as the minimum of the configured preference,
   verified credential ceiling, active switches, and budget capability. The v1
   build ceiling is `assisted`, because the service holds no B credential.
   Configuring `autonomous` therefore logs
   `autonomous_tier_capped_at_assisted` and resolves as assisted.

For existing shared-bot enrollments only, a missing `bot.json` falls back to the
request-named `bots/<B>.json`. An active legacy binding resolves read-only and
logs `legacy_binding_without_bot_json` once per owner per cache window. A
present canonical `bot.json` never falls back; without `bot.json` there is no
canonical key-generation value to enforce, so legacy bindings remain coherent
and read-only rather than being rejected for missing metadata.

The positive tenant document set expires 15 seconds after the cold resolution
finishes, aligned with the device-delegation cache. This bounds tier downgrades
and bot re-mints to 15 seconds plus the fetch span from the beginning of the
cold resolution: at most 30 seconds under the 5-second-per-read timeout and
three sequential tenant reads. The corresponding delegation bound is at most
20 seconds (one 5-second read plus the 15-second cache window). A slow fetch is
therefore still warm immediately after completion instead of being stamped
expired by its start time. Each cold tenant resolution adds up to three public
homeserver GETs and one limiter token is consumed per GET. Authoritative tenant
misses cache for 60 seconds; upstream failures cache for 30 seconds.
Delegations still cache positively for 15 seconds and re-verify owner, bot,
purpose, and expiry on every hit.

`config.brain` is recorded-only in v1. The service uses the deployment brain
until self-hosted brain serving exists; this applies to every tenant regardless
of the configured provider or model.

All currently served purposes (`ask`, `who-tagged-me`, and `build-feed`) require
at least read-only. Assisted publication remains client-side after explicit
approval; no served v1 endpoint requires assisted server authority. The
purpose-to-endpoint and purpose-to-minimum-tier tables are exhaustive schema
constants, so a new served purpose must declare both.

Nonces are unique per `(bot, asker)` in `pubchi_nonces` (migration `108_pubchi.sql`). Rows remain retained until `expires_at` is older than the verifier's `CLOCK_SKEW_SECONDS` tolerance, so replay protection covers the full accepted expiry window. Expired rows are deleted by the periodic sweeper.

Daily token reservations are atomic per owner UTC day in `pubchi_budget_day` (migration `109_pubchi_budget.sql`). Brain requests reserve the input estimate plus output allowance, then settle the sum of reported prompt, completion, and reasoning tokens across all attempts, floored at one and capped at the reservation; deterministic/no-brain paths keep their tiny charge. When the provider omits usage, Pubchi estimates `(rendered system and user prompt characters / 4) + (returned output characters / 4)`, rounded up and floored at one; provider failures use the rendered prompt estimate without output. Settlement and release always use the reservation's stored UTC day, even when they run after midnight. `resize` clamps the reservation to `min(reservation, usage)` and returns the unused portion; `refund` returns the full remaining reservation, and both are no-ops after a terminal settle or refund. Unused reservation is refunded and v1 requests carrying a `signer` remain subject to the 25% per-signer sub-cap.

## Environment

| Variable | Default | Role |
| --- | --- | --- |
| `PUBCHI_PORT` | `3015` | Listen port |
| `PUBCHI_BIND` | `127.0.0.1` | Loopback unless `PUBCHI_BIND_DANGEROUS=1` |
| `PUBCHI_BIND_DANGEROUS` | unset | Required for a non-loopback bind |
| `PUBCHI_DAILY_TOKEN_CEILING` | `200000` | Per-**owner** UTC-day tokens (`mention_key = pubchi:<U>`). The window is `date_trunc` in UTC, not the Postgres session timezone. |
| `PUBCHI_PER_REQUEST_TOKEN_CAP` | `10000` | Clamp on a single reserve/charge. Actual query/feed charges use the effective tenant's literal per-tier budgets: read-only output is 2000 and assisted output is 4000. |
| `PUBCHI_BODY_MAX_BYTES` | `65536` | Request body cap |
| `PUBCHI_REQUEST_TIMEOUT_MS` | `30000` | Slowloris bound |
| `PUBCHI_BUCKET_RATE_PER_SEC` | `2` | Per-**owner** token bucket refill |
| `PUBCHI_BUCKET_BURST` | `10` | Per-**owner** burst |
| `PUBCHI_PREAUTH_RPS` | `20` | Global pre-auth bucket (before parse/verify) |
| `PUBCHI_PREAUTH_BURST` | `40` | Global pre-auth burst |
| `PUBCHI_PREAUTH_IP_RPS` | `5` | Per-remote-address pre-auth refill |
| `PUBCHI_PREAUTH_IP_BURST` | `10` | Per-remote-address burst |
| `PUBCHI_TRUST_PROXY` | unset | Honour `X-Forwarded-For` **only** when set to `1`. The service binds loopback and is expected behind a proxy. |
| `PUBCHI_AUDIENCE_ORIGINS` | — | **Required.** Comma-separated exact API deployment origins; first is canonical. The service's own API origins are listed here. HTTPS only, except loopback HTTP when `PUBCHI_ALLOW_LOOPBACK_AUDIENCE=1`; normalized and without paths, credentials, queries, fragments, or wildcards. |
| `PUBCHI_V1_SUNSET` | — | **Required.** ISO instant with an explicit zone; after this instant v1 returns `VERSION_UNSUPPORTED`. |
| `PUBCHI_DELEGATION_CAP_AT` | — | **Required.** ISO instant with an explicit zone; delegations created at or after this instant are capped at seven days for v1 and v2. |
| `PUBCHI_ALLOW_LOOPBACK_AUDIENCE` | unset | Optional, development only. Set to `1` to allow loopback HTTP audience origins; production API origins remain HTTPS. |
| `DATABASE_URL` | — | Runtime Postgres URL for `--role pubchi` only. The migrator `DATABASE_URL` belongs solely to the separate `--role pubchi-migrate` service and is not a runtime alternative. `JEB_DB_URL_REASON` is forbidden. |
| `JEB_BRAIN` / `JEB_MODEL_*` | moonshot | Brain adapter/key/base URL. Model id for this role is `kimi-k3` from `PHASE0_BRAIN`. Egress allowlist unchanged; redirects refused. |
| `JEB_SCOUT_*` / `JEB_NEXUS_URL` | see table above | NLQ/Scout. The process refreshes `/v1/schema` on start (same as `--role nlq`); without a live schema the planner fails closed as `UPSTREAM_UNAVAILABLE`. |
| `PUBCHI_ALLOWED_ORIGINS` | empty | Comma-separated exact browser origins. Empty = no CORS headers. |

Must be **absent**: `PUBKY_BOT_SECRET_KEY_HEX`, `PUBKY_BOT_SECRET_KEY_FILE`, `PUBKY_BOT_MNEMONIC`. Startup calls `assertNoKeyMaterial()`.

## Ops notes

In-memory maps (`preauth` per-IP buckets, tenant cache, owner token-bucket state) have no eviction; growth is bounded by the global preauth bucket (~20 inserts/s worst case) and resets on process restart (accepted for Phase 0).

## Latency

Each `/v1/query` and `/v1/feed` request emits one `pubchi_request_timing` log with monotonic millisecond stages:
`body_parse_schema`, `signature_verify`, `tenant_resolve`, `delegation_resolve`, `nonce_consume`,
`budget_reserve`, `handler`, handler sub-stages (`nexus_ms`, `nlq_ms`, `brain_ms` when applicable),
`response_serialize`, and `total`. The log also records tenant/delegation cache hit or miss without
including request text or owner identifiers. The response exposes the same names
through `Server-Timing` durations only on 2xx responses so the App can attribute
its visible request timer; the full breakdown and cache hit/miss remain
server-side only for failures.

The production observation was 3398 ms total for `who-tagged-me`; no per-stage log was available before
instrumentation, so the dominant service stage could not be named from that request. The in-process
happy-path harness after instrumentation measured 3 ms total with mocked verification, budget, and
Nexus dependencies; it is not a production comparison. A live public homeserver reader reused one
`Pubky` client for two consecutive reads: 591 ms then 185 ms (the second read benefits from warmed
resolution). The service already constructs this reader once per process, and the Scout schema is
loaded once at process start then refreshed by the process cache. Tenant success
caching is 15s after fetch completion, while authoritative 404 misses remain
cached for 60s; upstream failures remain cached for 30s. This keeps slow-fetch
resolutions warm after completion, with the stale positive-entry window bounded
by the fetch timeout and the documented 30s tenant / 20s delegation worst cases.

## Proof commands

```bash
npm run build
PUBCHI_AUDIENCE_ORIGINS=https://pubchi-production.up.railway.app PUBCHI_V1_SUNSET=2026-10-09T00:00:00Z PUBCHI_DELEGATION_CAP_AT=2026-09-09T18:00:00Z npx vitest run src/pubchi src/pubchi-schemas src/pubchi-query.test.ts src/pubchi-production.test.ts packages/bot-kit/src/nlq
```

Full `npm test` needs a reachable Postgres. Vitest creates and migrates `jeb_vitest` automatically (see `docs/test-database.md`). Do not point the suite at `jeb_stage1_test`.

Live smoke (parent): if `JEB_MODEL_API_KEY` is unset, mark live smoke **unverified**. Do not hunt for keys.

## What Phase 1 adds

Real bot enrollment and reciprocal ownership in App, portable public-state schemas and export/import, complete Brain negotiation/input/output, provider registry, and a production-ready replaceable-brain package. Still no hosted session in the default read-only path.
