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

## Checkpoint 4 — audit remediation

Applied Stage 0 Kimi findings to the extracted runtime. Proof: `npx tsc --noEmit` pass; `npm test` **62 pass**; staging contract **19/19 in 114.91 s** via `dist-contract/contract-adapter.js` + `JEB_CONTRACT_MODE=1`; `docker compose config` pass.

| Finding | What changed | Test |
| --- | --- | --- |
| F3 / F-01 | `publish.ts`, `homeserver.ts`, `auth-error.ts`, `db.ts`, `metrics.ts`, `health.ts` — reauth once on 401/403; `failed_auth` + dequeue pause; health `publisher_auth` | `publish.test.ts` reauth retry + `failed_auth` no re-dequeue; `audit-hardening.test.ts` health extra |
| F-02 / F17 | `publish.ts` re-checks replies/global before PUT; `reason.ts` / `answer.ts` check generation/global before model and each tool | covered by existing switch paths + canned skip still after policy |
| F4 / F-03 | `policy.ts` `botRepliesInChain`; `reason.ts` + `nexus.ts` `walkAncestors` unresolved → mention as root, `thread_root_unresolved` | `audit-hardening.test.ts` forged parent; chain with prior bot reply; `policy.test.ts` |
| F-04 | `concurrency.ts` `JEB_REASON_CONCURRENCY` (default 2); `http.ts` AbortSignal; `JEB_NEXUS_TIMEOUT_MS` 10s | `audit-hardening.test.ts` semaphore + fetch timeout |
| F-09 | `context.ts` 600 / 6000 clip | `context.test.ts` |
| F-10 / F-11 / F13 | `nexus-schema.ts`, `nexus.ts` zod + z32 before URL; Nexus REST only (no attacker `publicStorage`) | `audit-hardening.test.ts` invalid author id; `tools.test.ts` SSRF |
| F6 / F8 / F9 / F-06 | `log.ts` redact list; `config.ts` parseSafe path+message only; `health.ts` empty 500 | `audit-hardening.test.ts` config privacy + health no stack |
| F2 / F-12 | `health.ts` loopback, timing-safe token, 404 if unset; `JEB_BIND` | `audit-hardening.test.ts` admin 404/401/200 |
| F12 | `homeserver.ts` signup only on `isNotRegistered`; drop `JEB_SIGNUP_TOKEN` after success | `audit-hardening.test.ts` signup classification |
| F15 | canned still `composeReply` + policy before write | `answer.test.ts` 2000 clamp; `audit-hardening.test.ts` canned + bot-chain skip |
| F16 / F-14 | `tsconfig.build.json` / `tsconfig.contract.json`; adapter needs `JEB_CONTRACT_MODE=1` + loopback Nexus | `audit-hardening.test.ts` guard; `dist/` has no `contract-adapter.js` |
| F1 / F5 / F-05 / F-13 / F-15 | `docker-compose.yml` no source/`.env` mount, Postgres `127.0.0.1`, password required, publish-only key, `restart`/`read_only`/`cap_drop`; exact dep pins; digest optional in Dockerfile/README | `docker compose config` |
| F7 / F-07 / F-08 | `keys.ts` `PUBKY_BOT_SECRET_KEY_FILE` 0600; `keygen.ts` fsync/0600/write errors; README/.env.example mnemonic footgun | `audit-hardening.test.ts` key file mode |

## UNVERIFIED
1. **Docker image build / compose up smoke** — `docker compose config` validated; image build still UNVERIFIED (daemon historically hung).
2. **Local pubky-testnet** — UDP 6881 occupied historically; contract used staging homeserver.
3. **Real staging Nexus mention → live Jeb reply** — only fixture Nexus + staging homeserver in the contract.
4. Crash between successful PUT and DB commit on a *real* homeserver (unit/contract cover related cases; ADR still lists a dedicated force-crash).
