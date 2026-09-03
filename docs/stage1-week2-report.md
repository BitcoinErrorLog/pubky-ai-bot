# Stage 1 week 2 report (ticket 7)

Working tree: `/Volumes/vibedrive/vibes-dev/pubky-ai-bot-jeb` branch `stage1/extract`.
Product source: **2103 LOC** in `src/` excluding `*.test.ts`.

## What moved / rewrote / died

### Moved from jeb-slim (`0bd3842`)
- `src/nexus.ts`, `context.ts`, `types.ts`, `log.ts`, `health.ts` (extended), `db.ts` (extended), `homeserver.ts` (split usage), `model.ts` (delay + leftover completeReply), `policy.ts` (extended), `config.ts` (zod + `JEB_*`), `keygen.ts`, `contract-adapter.ts` (now spawns processes), tests: `context.test.ts`, `db.test.ts`, `filter.test.ts`, `policy.test.ts`.

### Kept and adapted from Option A
- `src/infrastructure/database/migrator.ts` + numbered `001_jeb_foundation.sql` (slim schema + token_usage, blacklist, rate_limit_events, work_queue, evidence, publish_requests, switches, routing_audit).
- `src/injection-detector.ts` (+ two tests); content-preview log removed.
- `src/metrics.ts`: counters + action timer only.
- Fail-closed rate limit / blacklist on Postgres.
- Budget: `token_usage` + pre-call ceiling (`JEB_DAILY_TOKEN_BUDGET`).

### Rewritten at the trust boundary
- `src/ingest.ts`, `src/reason.ts`, `src/publish.ts`, `src/main.ts` (`--role ingest|reason|publish|all`).
- `--role all` and the contract adapter spawn **child processes**; ingest/reason env has keys stripped; reason `assertNoKeyMaterial()`.
- Publisher: typed `publish_requests`, SDK `putJson`, readback, parent-list idempotency, retry backoff, `fail_first_attempt` test hook.

### New (checkpoint 3)
- `src/intent.ts`, `modes.ts`, `tools.ts`, `compose.ts`, `answer.ts`.
- Nexus tools: `get_post`, `get_thread`, `get_user`, `get_user_tags`, `search_posts_by_tag`, `get_post_replies` (SSRF: configured Nexus host only).
- Fake OpenAI server: `tests/fake-openai.ts` (not imported by `src/` product modules except tests).

### Deleted
- Redis (`src/infrastructure/redis/**`, `redis` dep, Redis idempotency).
- `src/core/event-bus.ts`, `src/orchestration/**`, `classifier.ts`, `src/actions/**`, `summary.ts`, `factcheck-websearch.ts`, `secure-prompts.ts`.
- Old `PubkyService` / `ReplyService` / `ThreadService` / poller / JSON config loader / `config/*.json` except unused `source-credibility.json` (deleted).
- Jest; `@ai-sdk/mcp`.
- No Redis dependency remains in `package.json`.

## Proof

### Checkpoint 1 — extract slim runtime (`00ac6f9`)
- `npx tsc --noEmit`: pass
- `npm test`: 29 pass (12 slim + injection)
- Contract staging 19/19 in **105.42 s**

### Checkpoint 2 — split publisher process (`4209db9`)
- `npx tsc --noEmit`: pass
- `npm test`: 30 pass including `fail_first_attempt` → exactly one PUT after retry
- Contract 19/19 in **114.96 s** (adapter child processes). First CP2 contract run failed bot-to-bot thread cap (2 vs 1); fixed by counting in-thread `processing` rows excluding current key.

### Checkpoint 3 — answer intent + tool loop
- `npx tsc --noEmit`: pass
- `npm test`: **45 pass** (intent, SSRF, modes, canned/decline/ignore, fake OpenAI, evidence insert)
- Contract: **19/19 in 113.75 s** (canned still runs policy + `answer` intent + evidence + publish)

## Left out (on purpose)
- Scout tools, web search, RAG/pgvector, `sources.yaml` — later Stage 1 weeks.
- Per-thread/per-tool budget ceilings beyond daily global+user token cap.
- Independent Scout/web/proactive switch *enforcement* in the tool loop (tables/env exist; tools for those paths are not shipped).
- Kimi audit of key/publish/injection — not this ticket’s gate (open ADR item).

## UNVERIFIED
1. **Docker image build / compose smoke** — daemon hung; Dockerfile/compose written, not built.
2. **Local pubky-testnet** — UDP 6881 occupied historically; contract used staging homeserver.
3. **Real staging Nexus mention → live Jeb reply** — only fixture Nexus + staging homeserver in the contract.
4. Crash between successful PUT and DB commit on a *real* homeserver (unit/contract cover related cases; ADR still lists a dedicated force-crash).
