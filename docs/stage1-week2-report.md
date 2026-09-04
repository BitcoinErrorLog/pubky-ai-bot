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

### Checkpoint 1 — extract slim runtime (`0ef4037`)
- `npx tsc --noEmit`: pass
- `npm test`: 29 pass (12 slim + injection)
- Contract staging 19/19 in **105.42 s**

### Checkpoint 2 — split publisher process (`ac16ca6`)
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

## Checkpoint 5 — voice, continuation, compact composition, bot profile (ticket 11)

Proof: `npx tsc --noEmit` pass; `npm test` **133 pass, 1 skipped** (19 files); `npm run eval:voice` offline: 32 items, 0 forbidden-pattern escapes, 0 missing required patterns, 3 linter violations caught; staging contract **19/19 in 110.35 s** via `dist-contract/contract-adapter.js` + `JEB_CONTRACT_MODE=1`.

| Deliverable | What changed | Test |
| --- | --- | --- |
| Voice spec | `docs/voice.md` — identity, defaults, citation caps, R1–R3 evidence language, 15 paired positive/negative examples | enforced via linter + eval below |
| Voice linter | `src/voice.ts` — strips forbidden openers / AI disclaimers / throat-clearing, collapses exclamation runs, caps exclamation density at 2, removes emoji, citation cap (3 short / 8 sources), records violations | `src/voice.test.ts` (14) |
| Voice in composition | `compose.ts` runs the linter on every reply; canned path included; violations returned with the reply | `src/compose.test.ts` (11) |
| Evidence bundle | migration `040_voice.sql`: `evidence.voice_violations JSONB`; `db.ts`/`reason.ts`/`answer.ts` wiring | `src/answer.test.ts` evidence insert; `src/continuation.test.ts` |
| Voice eval | `eval/voice/voice-core.yaml` (32 items: prompt + context + forbidden/required regexes) + `scripts/eval-voice.ts` (`npm run eval:voice`); offline composition pass always, live model pass when `JEB_MODEL_API_KEY` set; per-rule violation table | `forbiddenHits` unit test; offline run in proof |
| Compact composition | one reply ≤2000; non-deep overflow truncates at a sentence boundary ending with `(ask for \`deep\` for more)`; `deep` → ONE `kind: long` ≤50000, never a chain | `src/compose.test.ts` |
| Natural modes | `modes.ts`: "keep it short", "go deep", "in depth", "sources please", "just the Pubky part" → `pubky_only` mode + system-prompt addendum | `src/compose.test.ts` mode parsing |
| Continuation | `context.ts` marks Jeb's own chain turns as `assistant Jeb`; `types.ts` parses/validates `parent_post_uri` on reply notifications; `reason.ts` treats the whole ancestor chain (incl. Jeb's replies) as context | `src/context.test.ts`, `src/continuation.test.ts` (6) |
| Bot-replier guard | `policy.ts` `declaredAutomation` (profile name/bio declares bot/automation) + `JEB_KNOWN_BOTS`; reason skips automated repliers; loop guard still caps depth per thread | `src/policy.test.ts`, `src/continuation.test.ts` |
| Ambient references | ingest filter accepts only `mention`/`reply` notification types with canonical URIs; tag/follow/new_post types dropped | `src/continuation.test.ts` fixture notifications |
| Transparent profile | `src/profile.ts` builds + validates via `PubkySpecsBuilder.createUser`; `scripts/profile.ts` (`npm run profile:publish`) uses `keys.ts` loading, gated by replies/global switches, refuses `JEB_CONTRACT_MODE=1`, `--dry-run` prints JSON | `src/profile.test.ts` (5, incl. dry-run spawn) |
| Intro post | `docs/intro-post.md` — short (973 chars) + `kind: long` version; text only | length checked manually |

Not run: `profile:publish` against staging (no bot identity decided yet); live voice eval pass (no `JEB_MODEL_API_KEY` in this session).
