# ADR 0001: Jeb runtime foundation

**Status:** Decided — extract the slim runtime; owner acceptance remains the Stage 0 gate  
**Date:** 2026-09-03

## Context

Jeb needs a deterministic shell around an agentic core, with typed read-only tools, pre-call budgets, evidence records, and an ingest/reason/publish trust split (`/Volumes/vibedrive/vibes-dev/.cursor/plans/jeb_rise_of_the_robots_9c1e4b27.plan.md:169-223`). Option A and Option B both passed the same staging contract at 19/19, while publish failure after generation was removed from that contract because SDK-native HTTP cannot be intercepted (`/Volumes/vibedrive/vibes-dev/jeb-contract/README.md:30-33`). Stage 0 therefore decides on structural fit and evidenced migration cost, not fashion or incumbency.

## Decision

**Extract the slim runtime (Option B) into `pubky-ai-bot`.** Keep its current Pubky transport, thread assembly, Postgres state machine, schemas, structured logging, health endpoint, and contract adapter; add the proven policy, audit, budget, injection, and metrics capabilities from A as smaller Postgres-backed modules. Do not retain Redis Streams: A's own report says the contract went green despite the event hops and that Streams are justified only for multiple workers (`docs/stage0-modernization-report.md:111-129`), while Stage 1 requires process separation by trust boundary rather than consumer-group topology.

Weighted result: **B 85/100, A 68/100, C 34/100**. Evidence that would flip the decision to A is a production-smoked A with a typed publisher process, durable post-publish reconciliation, and the Redis/router surface reduced below the evidenced **600–800 LOC** parity addition to B; absent all three, A adds migration risk without a Stage 1 capability.

## Scored matrix

Scores are 1–5; weighted points are `score × weight` (maximum 500).

| Criterion | Weight | A — evolve existing | B — extract slim runtime | C — greenfield |
|---|---:|---|---|---|
| Correct Pubky behavior | 20 | **5 → 100.** 19/19 staging contract; current SDK publish is `session.storage.putJson` (`src/services/pubky.ts:664-701`); timestamp cursor is persisted (`src/services/poller.ts:139-168,221-258`). | **5 → 100.** 19/19 in measured **104 s**; SDK-only publish/readback (`/Volumes/vibedrive/vibes-dev/jeb-slim/src/homeserver.ts:18-52,83-98`) and current Nexus `end` cursor (`/Volumes/vibedrive/vibes-dev/jeb-slim/src/nexus.ts:5-14`). | **1 → 20.** No implementation or contract result exists; the required behavior is only specified in the plan (`jeb_rise_of_the_robots_9c1e4b27.plan.md:119-123`). |
| Time to public candidate | 20 | **4 → 80.** Transport is repaired and kill switch measured at **2.5 s block / 3.2 s resume**, but Docker remains unverified and the router still supports only two actions (`docs/stage0-modernization-report.md:70-89,102-109`). | **4 → 80.** Built in roughly **two agent-hours**, already 19/19, typechecks, and has 12/12 unit tests (`/Volumes/vibedrive/vibes-dev/jeb-slim/REPORT.md:5-44`); it still needs the evidenced parity modules below. | **1 → 20.** It would rebuild transport, cursor, context, publisher, and state already proven in both implementations; Stage 1 starts in week 2 (`jeb_rise_of_the_robots_9c1e4b27.plan.md:226-235`). |
| Retry/duplicate safety | 15 | **3 → 45.** Streams reclaim pending entries and delay DLQ until max attempts (`src/core/event-bus.ts:60-67,109-148`), but the 24-hour Redis guard records `processing` before the operation (`src/core/idempotency.ts:10-64`) and reply dedupe fails open on DB error (`src/services/reply.ts:137-165`). | **5 → 75.** Postgres has explicit `processing/published/failed/skipped` states and atomic claim (`/Volumes/vibedrive/vibes-dev/jeb-slim/src/db.ts:3-43,84-123`); a restarted or duplicate delivery scans published posts by parent before proceeding (`/Volumes/vibedrive/vibes-dev/jeb-slim/src/bot.ts:110-148`). | **1 → 15.** Exactly-once publication is a requirement, not implemented evidence (`jeb_rise_of_the_robots_9c1e4b27.plan.md:169-173,218-223`). |
| Ease of adding knowledge + Scout tools | 15 | **3 → 45.** `AIService.generateText` already accepts tools (`src/services/ai.ts:147-199`), but classifier schema, event names, action types, and router are closed over `summary/factcheck` (`src/services/classifier.ts:6-12,115-152`; `src/core/events.ts:1-8,29-35`; `src/orchestration/types.ts:6-16,51-64`; `src/orchestration/router.ts:251-266`). | **4 → 60.** The general model call is one function (`/Volumes/vibedrive/vibes-dev/jeb-slim/src/model.ts:10-30`) and prompt/context are isolated (`/Volumes/vibedrive/vibes-dev/jeb-slim/src/context.ts:14-34`), so a typed tool loop replaces one seam; no Scout or RAG code exists yet. | **3 → 45.** Greenfield could mirror the target tool design (`jeb_rise_of_the_robots_9c1e4b27.plan.md:179-193`) but has no reusable implementation or measured behavior. |
| Maintainability/testability | 10 | **2 → 20.** TypeScript is explicitly non-strict (`tsconfig.json:2-23`); 60 unit tests took **133 s**, and the contract path traverses poller → stream → router → stream → worker (`docs/stage0-modernization-report.md:25-38,111-129`). | **4 → 40.** Strict TypeScript is enabled (`/Volumes/vibedrive/vibes-dev/jeb-slim/tsconfig.json:2-12`), product source is measured at **873 LOC excluding four test files**, and tests are 12/12 (`/Volumes/vibedrive/vibes-dev/jeb-slim/REPORT.md:5-44`). | **2 → 20.** It has a clean design brief but would create every test seam anew despite two passing transports (`jeb_rise_of_the_robots_9c1e4b27.plan.md:257-264`). |
| Operational cost/simplicity | 10 | **2 → 20.** One process still requires Postgres plus Redis, consumer groups, reclaim, retry maps, and DLQ (`src/server.ts:94-157,200-278`; `src/core/event-bus.ts:8-16,52-80,109-156`). | **5 → 50.** One process and Postgres only; health is a local HTTP check (`/Volumes/vibedrive/vibes-dev/jeb-slim/src/health.ts:1-19`) and all durable state is in three tables (`/Volumes/vibedrive/vibes-dev/jeb-slim/src/db.ts:20-43`). | **2 → 20.** The plan still requires three trust-boundary processes and Postgres/pgvector (`jeb_rise_of_the_robots_9c1e4b27.plan.md:169-184`), with no implementation offsetting that cost. |
| Security and key isolation | 10 | **3 → 30.** `PubkyService` encapsulates the session, but the same process constructs poller, model services, router, workers, and publisher (`src/server.ts:42-68,94-157`); no typed `PublishRequest` exists in events (`src/core/events.ts:1-62`). | **2 → 20.** `SessionTransport` encapsulates the session (`/Volumes/vibedrive/vibes-dev/jeb-slim/src/homeserver.ts:18-52`), but `Bot.start` opens it and `consume` performs both reasoning and publish in the same process (`/Volumes/vibedrive/vibes-dev/jeb-slim/src/bot.ts:38-48,188-199`). | **3 → 30.** The target explicitly isolates the publisher and signing secret (`jeb_rise_of_the_robots_9c1e4b27.plan.md:169-173,214-223`), but there is no implementation proving the boundary. |
| **Total** | **100** | **340/500 = 68/100** | **425/500 = 85/100** | **170/500 = 34/100** |

## Answers to the six decision questions

### 1. What B must absorb, and realistic LOC

B is **873 product LOC**, not 500: measured file totals are bot 206, DB 150, types 108, homeserver 98, config 67, Nexus 54, contract adapter 43, context 34, model 31, keygen 25, health 19, policy 15, logging 13, and index 10. The overage is mostly essential contract behavior: the crash/restart state machine is `db.ts:20-150` plus `bot.ts:79-204`, and SDK publication/readback/reconciliation is `homeserver.ts:18-98`; the 43-line adapter and 25-line key utility are removable from a production count, but compressing the rest toward 500 would remove explicit state or transport checks.

To reach A's useful parity, B must absorb:

- token usage and pre-call budget checks from `src/services/budget.ts:1-102` plus `src/infrastructure/database/migrations/004_token_usage.sql:1-20`; A still lacks the required per-thread and per-tool ceilings;
- routing-decision audit from `src/orchestration/router.ts:228-247` and `src/infrastructure/database/migrations/001_initial_schema.sql:60-72`;
- action executions, artifacts/evidence records, and reply audit from `src/infrastructure/database/migrations/001_initial_schema.sql:20-58` and `src/actions/summary/worker.ts:276-320`;
- fail-closed rate limit and blacklist behavior from `src/services/rate-limit.ts:60-135` and `src/services/blacklist.ts:61-88`, implemented in Postgres rather than porting their Redis dependency;
- Prometheus wiring from `src/services/metrics.ts:1-138`;
- injection normalization/detection from `src/services/injection-detector.ts:15-109`, while deleting its content preview log at lines 130-140;
- the provider/tool-call seam from `src/services/ai.ts:109-215`, not the closed intent router.

Those source slices are backed by **1,022 raw lines**: 797 lines for budget/metrics/rate-limit/blacklist/injection, 118 lines of audit schema/write paths, and 107 lines of provider/tool orchestration. Consolidating policy state into Postgres and avoiding A's wrappers makes **600–800 net new LOC** realistic. RAG, pgvector, typed Nexus/Scout tools, evidence bundles, per-path kill switches, and the publisher boundary are new Stage 1 work for either option, not hidden parity credit for A.

### 2. Does A's router help a general `answer` intent?

It fights it. `classifier.ts:6-12` validates only `summary|factcheck|unknown`, its prompt defines exactly two services at `classifier.ts:115-152`, `events.ts:1-8,29-35` has only summary/factcheck action events, `orchestration/types.ts:6-16,51-64` repeats those closed unions, and `router.ts:251-266` hard-codes a binary event selection. Adding `answer` therefore changes at least those four modules and adds another worker/event path; the reusable part is `AIService`'s tool-capable call (`src/services/ai.ts:147-199`), not the router.

### 3. Publisher/reasoning trust boundary

Neither implementation has it. A initializes Pubky, AI, router, and both workers in one process (`src/server.ts:94-157`), and workers call `ReplyService.publish` directly (`src/actions/summary/worker.ts:183-205`). B likewise opens the signed transport at startup and calls model then publish in one `consume` method (`/Volumes/vibedrive/vibes-dev/jeb-slim/src/bot.ts:38-48,188-199`).

The B split is smaller: turn `homeserver.ts:58-98` into the publisher process, define `PublishRequest { mentionId, parentUri, content }`, and replace the direct call at `bot.ts:197-199` with a local typed queue. A has queue infrastructure, but its event model has no publish request and its `PubkyService` combines public reads, Nexus access, session creation, and writes; splitting it crosses `server.ts`, `events.ts`, both workers, `ReplyService`, and `PubkyService`.

### 4. Meaning of 184 s versus 104 s

It proves only that the measured A contract run was **80 s / 1.77×** slower under those adapter settings. A polls every **1,000 ms** (`src/contract-adapter.ts:52-54`), while B polls every **40 ms** (`/Volumes/vibedrive/vibes-dev/jeb-slim/src/contract-adapter.ts:27-31`), and A adds two Redis stream hops (`docs/stage0-modernization-report.md:111-129`). Because polling cadence, scheduling, and orchestration all differ, the result cannot isolate Redis round trips or predict model/tool latency; it is a candidate-level regression signal, not a causal benchmark.

### 5. Idempotency under crash and duplicates

B is more robust. Its durable row state is claimed atomically and failed rows are explicitly reclaimable (`/Volumes/vibedrive/vibes-dev/jeb-slim/src/db.ts:84-123`); when a delivery finds `processing`, it scans the bot's published posts for the same parent and marks the row published before returning (`/Volumes/vibedrive/vibes-dev/jeb-slim/src/bot.ts:135-148`), with stale reconciliation at lines 110-116. That closes the crash-after-PUT/before-DB-update window by observing the homeserver.

A's Redis guard writes `processing` with a 24-hour TTL before the operation and only stores the result afterward (`src/core/idempotency.ts:10-64`). If the process dies after PUT but before `replies` insertion, the reclaimed stream delivery sees `processing`, returns without executing, and is acknowledged (`src/core/event-bus.ts:109-148`); the Postgres reply audit remains absent, and DB lookup errors deliberately continue to publish (`src/services/reply.ts:137-165`). Both passed the existing crash test (`/Volumes/vibedrive/vibes-dev/jeb-contract/tests/contract.test.ts:196-213`), but that test stops only after the harness has already observed a published reply, so it does not force the precise PUT/DB boundary.

### 6. What remains unverified

For both options:

1. **Production container:** A's Docker daemon hung (`docs/stage0-modernization-report.md:70-76`); B has no recorded container smoke proof (`/Volumes/vibedrive/vibes-dev/jeb-slim/REPORT.md:1-59`).
2. **Publish failure after generation:** deliberately absent because native/WASM HTTP bypasses fetch interception (`/Volumes/vibedrive/vibes-dev/jeb-contract/README.md:30-33`).
3. **Real local testnet:** staging homeserver was used because UDP 6881 was occupied (`/Volumes/vibedrive/vibes-dev/jeb-slim/REPORT.md:57-59`); the contract's Nexus remained the fixture server.

Close these before Stage 1 week 2 feature work: build and run the chosen production image; inject a first-request failure at the new typed publisher boundary and assert retry plus one homeserver reply; run all 14 behavioral cases against `Pubky.testnet()` when its ports are free; then perform one real staging Nexus mention → signed staging reply smoke test. Record each command, duration, and result in the Stage 1 report.

## Consequences

Stage 1 week 2 starts by moving the proven slim core into this repository before adding capabilities:

- **Move and preserve behavior:** `jeb-slim/src/nexus.ts`, `context.ts`, URI/notification portions of `types.ts`, `log.ts`, `health.ts`, and the contract adapter/tests.
- **Rewrite at the boundary:** split `bot.ts` into ingest and reason processes; split `homeserver.ts` into public read helpers and a publisher process that alone loads the secret; replace direct publish with a typed `PublishRequest`; expand `db.ts` via migrations for usage, routing, executions, evidence/artifacts, and per-path switches; replace `model.ts` with a provider-neutral `answer` tool loop.
- **Reimplement compactly from A:** budget accounting, routing audit, artifacts/evidence records, fail-closed rate/blacklist policy, Prometheus metrics, and injection detection. Port behavior and tests, not Redis storage or class scaffolding.
- **Delete after parity proof:** `src/core/event-bus.ts`, `src/infrastructure/redis/streams.ts`, Redis idempotency, `src/orchestration/router.ts`, `src/services/classifier.ts`, summary/factcheck worker wrappers, and the Redis dependency. Retire the monolithic `PubkyService` and `ReplyService` only after their SDK/thread/publish contract cases pass on the extracted modules.

The first acceptance gate is not RAG: it is the three-process trust split plus the missing publisher-failure test, with 19/19 contract behavior retained. Then add default `answer`, pre-call user/thread/global/model/web/Scout budgets, an evidence bundle for every answer, typed Nexus/Scout tools, and pgvector retrieval in that order.

## Open verification items

- [ ] Chosen production image builds, starts, reports healthy, and publishes via SDK.
- [ ] First publisher request fails, retries, and creates exactly one reply.
- [ ] Crash is forced between successful PUT and local state commit; restart reconciles to `published`.
- [ ] All 14 behavioral cases pass on local `pubky-testnet`.
- [ ] One real staging Nexus notification produces one signed staging reply.
- [ ] Per-path switches independently stop consumption, generation, Scout, web, replies, and proactive posts.
- [ ] Reason process environment and logs contain no signing secret; only publisher accepts `PublishRequest`.
- [ ] Kimi audit covers key/session loading, publish isolation, injection boundary, and Scout guardrails before public launch (`jeb_rise_of_the_robots_9c1e4b27.plan.md:394-405`).
