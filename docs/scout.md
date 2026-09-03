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

Intents that may call Scout: `research_pubky`, `find`, `compare`, `evidence_map`, `answer`.

Kill switch: Postgres `switches.scout` or `JEB_SWITCH_SCOUT=1`. Caps: `JEB_SCOUT_PER_MENTION_CAP` (12, **ok=TRUE rows only**), `JEB_SCOUT_DAILY_CEILING` (400, ok only). Failed tool calls do not consume the per-mention cap. `RATE_LIMITED` sets an 8s backoff and returns a tool error the model can explain (“graph lookup unavailable right now”). Every tool call is logged at info as `tool call name=… ms=… ok=…` with `mention_key` (argument values stay at debug).

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

**Run a Jeb-owned Scout + replica for production Jeb.** The public instance’s 50 rps cap is global and shared with everyone. Upstream still has open **F1** (nightly re-clone + write canary exists only as prose) and **F4** (per-IP rate limiting commented out in Caddy). Authentication is a documented follow-up. Use the public instance for staging/dev; Jeb’s `scout_queries` table is the load evidence for proposing F4 and auth upstream (`pubky/nexus-scout` PRs need explicit permission).

## Behaviour vs the ticket’s Scout facts

- Confirmed: public, no auth; `GET /llms.txt`, `GET /v1/schema`, `POST /v1/query`; envelope `{results,count,truncated,notes?}` or `{error,message,hint}`; nodes User/Post/File; rels FOLLOWS, AUTHORED, TAGGED, REPLIED, REPOSTED, BOOKMARKED, MENTIONED, MUTED; post URI `pubky://{user.id}/pub/pubky.app/posts/{post.id}`; 10 s server timeout; default 25 / max 100 rows.
- **Contradiction (ticket vs live Scout):** the ticket asked Jeb to allow `CALL {…}` read subqueries. Live `llms.txt` rejects **`CALL` in every form**, including `CALL {}`. Jeb’s `query_graph` guard matches that: any `CALL` (including `CALL {`) is rejected locally with `Scout does not permit CALL`. Namespaced `CALL db.|apoc.|gds.` are rejected on both sides (`namespaced CALL rejected`).
- **`truncated`:** gateway-only flag. A full page at the client `LIMIT` stays `truncated: false` (notes may say the page filled). Tools pass the gateway flag through and do not infer truncation from `count === LIMIT`; treat a full page as possibly incomplete even when `truncated` is false.
- FOLLOWS on the live schema includes an `id` property as well as `indexed_at`.
- Pattern `EXISTS { MATCH … }` (Cypher 5) is accepted on the public instance (used by topic/emerging/search tag filters).
