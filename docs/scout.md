# Scout tools (Stage 1 week 3)

Typed, parametrised Cypher tools against Nexus Scout. Tools return **evidence** (URIs, authors, timestamps, claim counts + claimant ids, scope, `truncated`). They do not return interpretation strings (R1).

Cached: `docs/scout-llms.txt` (fetched 2026-09-03), `src/scout/schema.golden.json`.

## Tools

| Tool | Purpose |
| --- | --- |
| `search_posts` | Content substring + optional authors, tags, time |
| `scout_get_thread` | REPLIED chain up and down (Nexus `get_thread` remains the REST ancestor walk) |
| `get_identity_summary` | Posts / followers / following / tags-received grouped by label |
| `get_topic_brief` | Posts on a tag or substring; top authors; distinct participants |
| `get_what_changed` | Topic posts and tag claims since a timestamp |
| `get_related_posts` | `replied` / `reposted` / `mentioned` / `tagged` / `same_author` |
| `get_relationship` | Follows both ways, mutual tags, shared taggers |
| `get_tag_landscape` | Who applies a tag, to whom, self vs third-party, tagger overlap |
| `get_emerging_topics` | Labels with rising distinct-tagger counts vs prior window |
| `get_debate_map` | Reply chains whose participants tagged each other with differing labels |
| `query_graph` | Guarded raw Cypher; `JEB_SCOUT_RAW_ENABLED=1` only |
| `search_users_by_name` | Resolve display names (not unique) to pubky ids |
| `rank_users` | Rank users by tags applied/received, posts, followers, following, or `tags_applied_per_post` (lurker ratio) |
| `recommend_follows` | Users followed by ≥2 of the subject's follows that the subject does not follow, ranked by mutual-follow count then tag overlap |
| `stale_follows` | Accounts the subject follows whose latest post `indexed_at` is older than `inactive_days` (default 60), or who have no posts |
| `follow_path` | Shortest FOLLOWS hop chain(s) from a to b (max 3 hops) plus how many alternatives exist at that length |
| `trust_view` | Tag claim counts on a user or topic posts, labelled global vs asker's 1–2 hop FOLLOWS graph |
| `top_posts` | Most bookmarked / reposted / replied posts in a window (optional tag); the graph has no likes |
| `mentions_of` | Posts with a `MENTIONED` edge to a pubky in a time window |
| `profile_card` | Factual account snapshot; muted only as an aggregate count |

Intents that may call Scout: `research_pubky`, `find`, `compare`, `evidence_map`, `answer`.

Kill switch: Postgres `switches.scout` or `JEB_SWITCH_SCOUT=1`. Caps: `JEB_SCOUT_PER_MENTION_CAP` (12, **ok=TRUE rows only**), `JEB_SCOUT_DAILY_CEILING` (400, ok only). Failed tool calls do not consume the per-mention cap. `RATE_LIMITED` sets an 8s backoff and returns a tool error the model can explain (“graph lookup unavailable right now”). Every tool call is logged at info as `tool call name=… ms=… ok=…` with `mention_key` (argument values stay at debug).

## What Jeb sends to Scout (outgoing posture)

Jeb is a **client** of Scout, not a Scout server. There is no inbound Scout port on Jeb, so “per-IP limits in front of Jeb” do not apply; abuse of the shared production Scout is bounded on the way **out**.

| Control | Env / field | Default | Effect |
| --- | --- | --- | --- |
| Endpoint | `JEB_SCOUT_URL` / `scoutUrl` | `https://nexus-scout.pubky.app` | Single origin; SSRF host pin in `ScoutClient` |
| HTTP timeout | `JEB_SCOUT_TIMEOUT_MS` | 12_000 | AbortController on `/v1/query` and `/v1/schema` |
| Page size | `JEB_SCOUT_LIMIT_MAX` / `scoutLimitMax` | 50 (server max 100) | Clamped per call |
| Reason in-flight answers | `JEB_REASON_CONCURRENCY` | 2 | Caps how many mentions can issue Scout calls at once |
| Per-mention ok calls | `JEB_SCOUT_PER_MENTION_CAP` | 12 | Postgres `scout_queries` where `ok = TRUE` |
| UTC-day ok calls | `JEB_SCOUT_DAILY_CEILING` | 400 | Same |
| Client QPS | `JEB_SCOUT_MAX_QPS` | **2** | Token bucket on outgoing `ScoutClient.query` (see below) |
| Schema refresh | `JEB_SCOUT_SCHEMA_REFRESH_MS` | **21_600_000** (6 h) | Reason process fetches `GET /v1/schema`, validates, caches; fetch failure keeps golden/last-good and increments `scoutSchema.fallbackCount` |
| Error-rate breaker | `JEB_SCOUT_BREAKER_*` | 5 failures / 60s, 60s cooldown | `SCOUT_BACKOFF` → same “graph lookup unavailable” path |

**QPS default.** Live template latencies on 2026-09-04 (`docs/scout-measure-2026-09-04.json`) are ~60 ms–1.2 s (many tools 200–500 ms, `get_debate_map` ~1.2 s). Two QPS matches about two concurrent in-flight calls at ~500 ms each — the same order as `JEB_REASON_CONCURRENCY=2` — and keeps a 12-call mention under a few seconds of Scout time inside the 180 s answer budget. It is a small slice of the public instance’s shared 50 rps cap. Over-limit calls **wait** up to `scoutTimeoutMs` for a token; if none, they fail with `RATE_LIMITED` / “graph lookup unavailable right now” (existing evidence-unavailable path). They do not crash the reason worker and do not trip the HTTP error-rate breaker.

The public Scout still has **F4** (per-IP Caddy limits) commented out upstream; Jeb cannot install that on a host it does not operate. The client bucket is the control Jeb owns.

## Write canary (F1)

`src/scout/canary.ts` POSTs write-shaped Cypher (`CREATE`, `MERGE`, `SET`, `DELETE`, `CALL dbms.*`, `LOAD CSV`, `apoc.create.node`) using label `JebCanary` and a per-run nonce, then `MATCH (n:JebCanary) RETURN count(n)`. Every write must be **rejected** (non-2xx or an explicit error envelope). A 2xx success envelope, or a follow-up count > 0, is **acceptance**: log at error, insert `scout_canary`, flip the existing Postgres `switches.scout` row (same switch as the kill-switch drill / `POST /admin/switch/scout`), and expose the snapshot on the reason `/healthz` as `scoutCanary`.

Network errors and 5xx are **unknown**, not accepted. After `JEB_SCOUT_CANARY_UNKNOWN_THRESHOLD` (default 3) consecutive unknowns the canary logs at error; it does **not** flip the switch. Interval `JEB_SCOUT_CANARY_INTERVAL_MS` (default 1 h). Loop off: `JEB_SCOUT_CANARY_ENABLED=false`. Operator one-shot: `--role scout-canary` (exit 0 pass, 1 accepted write, 2 unknown).

The loop runs inside **`runReason`** (roles `reason` and the reason child of `all`). Scout tools only execute in the reason process; starting the timer there avoids a second loop in the supervisor and keeps health state next to the Scout client. `--role all` does not probe twice. The loop is skipped when `JEB_CONTRACT_MODE=1` so contract process tests do not POST writes at production Scout.

Live production probe (read-only intent): `docs/scout-canary-2026-09-04.txt`.

## Schema cache, health, and NL planner input

`GET /v1/schema` is fetched when the reason process constructs `ScoutWriteCanary` (reason startup) and every `JEB_SCOUT_SCHEMA_REFRESH_MS` (default 6 hours). The payload is validated with zod against the shape of `src/scout/schema.golden.json`. A failed fetch never crashes reason: Jeb logs at warn, increments `fallbackCount`, and keeps the last good schema or the golden copy.

**Health** (reason `/healthz`, nested on `scoutCanary.scoutSchema` until the parent lifts it to a sibling of `scoutCanary`):

| Field | Meaning |
| --- | --- |
| `labels` | Node label names in the active schema |
| `relationshipTypes` | Relationship type names |
| `propertyCounts.nodes` / `.relationships` / `.properties` | Counts of node types, rel rows, distinct property names |
| `source` | `live` after a successful fetch, `golden` when using the bundled copy |
| `fetched_at` | ISO timestamp of the last successful activate (live or fallback) |
| `fallbackCount` | How many fetch/validate failures have occurred this process |

**Diff alarm.** After a live fetch, Jeb compares the schema to template dependencies derived mechanically from `allTemplateCyphers()` (`src/scout/schema-deps.ts` — not a hand-typed list). Missing labels, relationship types, or properties log at **error** (`scout_schema_alarm`). Extra live labels are allowed and become usable in `query_graph` after refresh.

**Schema-aware guard.** With `JEB_SCOUT_RAW_ENABLED=1`, `guardRawCypher` still applies every existing write/admin/CALL/LIMIT/profiling/MUTED rule, then rejects Cypher that names a label, relationship type, or property absent from the **active** schema (stops probing hidden/internal names). Labels or rel types present in the schema with `private: true` or `denied: true` are also rejected.

**NL query service (Stage 3 §6.3).** `summarizeScoutSchema` in `src/scout/schema-summary.ts` returns a deterministic text + JSON digest (≤ ~2k chars): labels with properties, rel types as `from→to`. The NL query service should inject `summary.text` (or `summary.json`) into the planner prompt as the only graph vocabulary the model may use, then compile to typed tools or guarded Cypher. **Jeb `answer.ts` is not wired to this summary in this change.** Live vs golden snapshot: `docs/scout-schema-2026-09-04.txt`.

## Live measurement (public instance, 2026-09-03)

Base `https://nexus-scout.pubky.app`. Wall-clock includes HTTP + client logging.

| Tool / input | Latency ms | Result n | truncated |
| --- | ---: | ---: | --- |
| `search_posts` query=`bitcoin` | 1983 | 5 | false |
| `search_posts` query=`pubky` | 328 | 5 | false |
| `scout_get_thread` (first bitcoin hit) | 1418 | 3 | false |
| `get_related_posts` replied | 680 | 0 | false |
| `get_tag_landscape` tag=`bitcoin` | 1314 | (applications+overlap) | false |
| `get_tag_landscape` tag=`pubky` | 431 | | false |
| `get_topic_brief` topic=`bitcoin` | 1163 | 25 | false |
| `get_what_changed` topic=`pubky` since 7d | 591 | 19 | false |
| `get_emerging_topics` 90d vs prior | 696 | 16 | false |
| `get_debate_map` topic=`bitcoin` | 1935 | 20 | false |
| `search_users_by_name` John Carvalho | 161 | 2 | false |
| `rank_users` `tags_applied_per_post` limit=3 | 2438 | 3 | false |
| `get_identity_summary` (top name hit) | 323 | (counts+claims) | false |
| `get_relationship` (two name hits) | 972 | | false |

Live lurker query top-3 pubky ids (`rank_users(tags_applied_per_post)`, 2026-09-03):

1. `c5jsbrwmouzedmf11qijk3gp8qeizkdsgtneq5t185jc41wxn6my`
2. `51da3n5m8s6oaq38uqs7jznp6ezbc3qbtmic8oy6fj3g6mokdyco`
3. `i77dybuortug6ypkf1r3tj9z3h8aq6xzga15dwef3fmaaohq8wqo`

Live follow-graph query top-3 pubky ids (`recommend_follows` / `stale_follows` on `gujx6qd8ksydh1makdphd3bxu351d9b8waqka8hfg6q7hnqkxexo`, 2026-09-04):

`recommend_follows`:

1. `fjg6jiak73ew47stdbewdwejtxwysr5tx4o35d46jqnwjdeh4iwo`
2. `zw75pu6otojyp38c6h98d6xp8brg1mgpny8aqe8hab49r81qk6ro`
3. `k6ms5ysh1bekn96pbyoea9art7n9q7owt37qjxkcc17ef9rnmo5y`

`stale_follows` (inactive_days=60):

1. `dxkchoec71h9w65heqigitcpmbbkifrnbojymjt1afk1pt1as8so`
2. `qr3xqyz3e5cyf9npgxc5zfp15ehhcis6gqsxob4une7bwwazekry`
3. `ibp95chdqtkczqior6waitd86nrda7sg34iai71mqwwuqw4agrmo`

`scout_queries` for `mention_key=measure` (HTTP-level rows, not tool-level n):

| tool | calls | avg_ms | rows | any_trunc |
| --- | ---: | ---: | ---: | --- |
| get_debate_map | 1 | 1933 | 30 | false |
| get_emerging_topics | 2 | 347 | 50 | false |
| get_identity_summary | 4 | 80 | 17 | false |
| get_related_posts | 1 | 678 | 0 | false |
| get_relationship | 3 | 322 | 6 | false |
| get_tag_landscape | 4 | 435 | 130 | false |
| get_topic_brief | 1 | 1161 | 25 | false |
| get_what_changed | 1 | 589 | 19 | false |
| scout_get_thread | 2 | 707 | 3 | false |
| search_posts | 2 | 1152 | 10 | false |
| search_users_by_name | 1 | 161 | 2 | false |

## Production recommendation (plan §4.4)

**Shared public Scout plus Jeb-side canary and QPS**, until a Jeb-owned replica is actually provisioned. See the decision note at the end of this file. The public instance’s 50 rps cap is global and shared. Upstream still has open **F1** (write canary as a Scout-side job) and **F4** (per-IP rate limiting commented out in Caddy). Authentication is a documented follow-up. Jeb’s `scout_queries` and `scout_canary` tables are the load/integrity evidence for proposing F4 and auth upstream (`pubky/nexus-scout` PRs need explicit permission).

## Behaviour vs the ticket’s Scout facts

- Confirmed: public, no auth; `GET /llms.txt`, `GET /v1/schema`, `POST /v1/query`; envelope `{results,count,truncated,notes?}` or `{error,message,hint}`; nodes User/Post/File; rels FOLLOWS, AUTHORED, TAGGED, REPLIED, REPOSTED, BOOKMARKED, MENTIONED, MUTED; post URI `pubky://{user.id}/pub/pubky.app/posts/{post.id}`; 10 s server timeout; default 25 / max 100 rows.
- **Contradiction (ticket vs live Scout):** the ticket asked Jeb to allow `CALL {…}` read subqueries. Live `llms.txt` rejects **`CALL` in every form**, including `CALL {}`. Jeb’s `query_graph` guard matches that: any `CALL` (including `CALL {`) is rejected locally with `Scout does not permit CALL`. Namespaced `CALL db.|apoc.|gds.` are rejected on both sides (`namespaced CALL rejected`).
- **`truncated`:** gateway-only flag. A full page at the client `LIMIT` stays `truncated: false` (notes may say the page filled). Tools pass the gateway flag through and do not infer truncation from `count === LIMIT`; treat a full page as possibly incomplete even when `truncated` is false.
- FOLLOWS on the live schema includes an `id` property as well as `indexed_at`.
- Pattern `EXISTS { MATCH … }` (Cypher 5) is accepted on the public instance (used by topic/emerging/search tag filters).

## follow_path

**Purpose.** Answer “how am I connected to X” / “is X within my 2-hop FOLLOWS graph” with shortest directed `FOLLOWS` paths, never a trust verdict.

**Params.** `a`, `b` (pubkys), optional `max_hops` (1–3, default 3), optional `limit` (capped).

**What the answer must say.** Report the hop chain as pubky ids (names when present), hop count, and how many alternative shortest paths exist at that length. If none, say there is no FOLLOWS path within `max_hops`. Do not call the path “trust”.

## trust_view

**Purpose.** Same tag-claim counts an evidence map would show, split into **global** vs **your graph** (claimants who are the asker or within 1–2 FOLLOWS hops).

**Params.** `asker` (required), exactly one of `target` (user tags received) or `topic` (tags on posts matching the label/substring), optional `hops` (1–2), `time_range`, `limit`.

**What the answer must say.** For each label, give **both** numbers and label them (`everyone: N taggers; within 2 follows of you: M`). Counts are claims by taggers, not character or topic verdicts. Never collapse this into a single verdict. If the asker's graph series is all zeros, say the 1–2 hop follow graph is empty (typical for a new user). Evidence-map answers must call `trust_view` with `asker` set to the mention author.

## top_posts

**Purpose.** Honest substitute for “trending / most liked / popular posts”. The graph has **no likes**.

**Params.** `metric` = `bookmarks` | `reposts` | `replies`, optional `time_range` (same default window as `get_emerging_topics`), optional `topic` tag label, `limit`.

**What the answer must say.** Cite post URIs, author pubkys, the metric count, and a short content preview. State that ranking is by that metric, not likes. Do not call the winner “most popular” as a verdict.

## mentions_of

**Purpose.** “Who mentioned me this week” via `MENTIONED` (Post→User).

**Params.** `pubky`, optional `time_range` (window), `limit`.

**What the answer must say.** List mentioning post URIs and author pubkys (names when present) in the window. Do not infer intent from a mention.

## profile_card

**Purpose.** Factual account snapshot.

**Params.** `pubky`, optional `asker` (for mutual-follow flags).

**What the answer must say.** First indexed time, post count, followers/following counts, top tags received and applied as label+count (claims), top 5 most-replied-to accounts by reply count, mutual FOLLOWS with the asker when supplied. `muted_count` is an aggregate of incoming `MUTED` edges only — never list who muted whom.

## Live measure — production Scout, 2026-09-04

`JEB_SCOUT_URL=https://nexus-scout.pubky.app npx tsx src/scout/measure.ts`; every template returned `ok`, zero guard rejections. Raw output: `scout-measure-2026-09-04.json`.

| tool | avg ms | rows |
|---|---|---|
| follow_path | 309 | 2 |
| trust_view | 469 | 14 |
| top_posts | 428 | 5 |
| mentions_of | 229 | 5 |
| profile_card | 178 | 29 |
| get_debate_map | 1234 | 30 |
| get_emerging_topics | 86 | 50 |
| get_identity_summary | 59 | 17 |
| get_related_posts | 520 | 0 |
| get_relationship | 60 | 6 |
| get_tag_landscape | 229 | 130 |
| get_topic_brief | 165 | 25 |
| get_what_changed | 501 | 17 |
| scout_get_thread | 523 | 3 |
| search_posts | 281 | 10 |
| search_users_by_name | 244 | 2 |

## Decision: Jeb-owned Scout vs shared production Scout (2026-09-04)

Jeb currently queries the public instance (`JEB_SCOUT_URL` default `https://nexus-scout.pubky.app`). That gateway is unauthenticated, globally capped (~50 rps), and shared with every other client. Jeb does not run Caddy in front of Scout, so it cannot turn on upstream F4 (per-IP limits) itself.

A **Jeb-owned Scout** would require:

- Read access to a Nexus Neo4j replica (or an agreed snapshot/clone cadence). That is Nexus-ops, not a Jeb config flag. Without a replica, a private Scout would still point at the production graph or go stale.
- A deploy footprint: container + Caddy (or equivalent) on Railway next to Jeb, env for Neo4j bolt, disk/CPU sized for the clone, and an operator to rotate the clone (upstream F1). Auth, if added, is a Scout change plus a Jeb header/token.
- Ongoing cost and a second failure domain (Jeb up, private Scout down).

**What the canary + client QPS buy without that instance:**

- Canary detects a replica that starts accepting writes (or returns `JebCanary` nodes) and flips `switches.scout` so product tools stop. It does not replace Scout-side F1; it is Jeb’s independent check of the endpoint Jeb actually queries.
- Token bucket + existing per-mention/daily caps bound Jeb’s share of the public 50 rps. A mention burst waits or returns evidence-unavailable instead of stacking unbounded POSTs.

**Recommendation.** Stay on the shared production Scout for Jeb until a Neo4j replica and Railway Scout service are explicitly provisioned. The canary and 2 QPS default are the production posture Jeb can ship without new infra. Revisit a Jeb-owned instance if `scout_queries` shows Jeb approaching a material fraction of the shared cap, if unauthenticated neighbors cause 429s that the breaker cannot absorb, or if write-canary failures require isolating Jeb from the public gateway.
