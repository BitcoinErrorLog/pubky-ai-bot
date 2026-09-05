# ADR 0006: Scout instance mode

**Status:** Accepted 2026-09-05 (operator decision)  
**Date:** 2026-09-05  
**Supersedes the informal note in** `docs/scout.md` (Decision: Jeb-owned Scout vs shared production Scout, 2026-09-04).

## Context

Production Jeb queries the shared public Scout gateway (`JEB_SCOUT_URL` default `https://nexus-scout.pubky.app`). That instance is unauthenticated, globally capped (~50 rps), and shared with every other client. Jeb already ships three client-side protections:

- **Write canary** (`--role scout-canary`): probes CREATE/MERGE/SET/DELETE/CALL dbms/LOAD CSV/APOC write plus a MATCH count. On 2026-09-04 the live run exited 0: every write-shaped statement was HTTP 400, `MATCH (n:JebCanary)` count=0, `readCount=0`, `consecutiveUnknown=0`, `switchFlipped=false`, `durationMs=992` (`docs/scout-canary-2026-09-04.txt`).
- **Client QPS limit:** token bucket default `JEB_SCOUT_MAX_QPS=2` (`src/config.ts`), well under the shared 50 rps cap.
- **Fail-closed breaker:** 5 failures / 60 s window, 60 s cooldown (`packages/bot-kit/src/scout/circuit.ts`).

Live public-instance cost on 2026-09-04 (`docs/scout-measure-2026-09-04.json`) is hundreds of ms per template, not multi-second saturation: `get_debate_map` 1234 ms avg (30 rows), `profile_card` 178 ms avg over 7 calls (29 rows), `follow_path` 309 ms avg, `get_emerging_topics` 86 ms avg (50 rows), `search_posts` 281 ms avg. Live wall times range 166–1263 ms. Nothing in that snapshot shows Jeb approaching a material fraction of the shared cap.

A Jeb-owned Scout would need a Nexus Neo4j replica (Nexus-ops, not a Jeb flag), a Railway/Caddy deploy, clone rotation, and a second failure domain. Upstream auth (and Caddy per-IP limits) remain Scout-side work.

## Options

- **A — Stay on the shared public Scout** with the canary, 2 QPS bucket, and fail-closed breaker already in place. Defer a Jeb-owned instance until canary or `scout_queries` load data show a need. Upstream auth stays a BitcoinErrorLog fork-first item.
- **B — Provision a Jeb-owned Scout now.** Requires a Neo4j replica and a new service before any load or write-accepting evidence exists.
- **C — Block on upstream auth/F4 before Jeb uses Scout in production.** Jeb cannot turn on Scout-side Caddy limits itself.

## Decision

**Option A.** Production Jeb keeps using the shared public Scout instance. The write canary, client-side QPS limit, and fail-closed breaker are the production posture. A Jeb-owned instance is deferred until the canary fails (writes accepted or `JebCanary` nodes appear) or `scout_queries` shows Jeb taking a material share of the 50 rps cap or 429s the breaker cannot absorb. The upstream auth proposal stays fork-first (`BitcoinErrorLog`); no `synonymdev`/`pubky` PR without explicit permission.

## Consequences

- No new Scout infra for Jeb. Operators run `--role scout-canary` against the URL Jeb actually queries.
- QPS stays at 2 unless `scout_queries` justifies a raise that still fits under the shared cap.
- Auth/F4 remain Scout-side; Jeb records evidence in `scout_queries` / `scout_canary` for a later fork-first proposal.

## What would change our mind

- Canary classifies a write as accepted, or `MATCH (n:JebCanary)` returns a positive count.
- `scout_queries` shows Jeb approaching a material fraction of the shared 50 rps, or unauthenticated neighbors cause 429s the breaker cannot absorb.
- A Neo4j replica and Railway Scout service are explicitly provisioned.
