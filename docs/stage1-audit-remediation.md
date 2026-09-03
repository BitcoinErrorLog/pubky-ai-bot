# Stage 1 audit remediation — Kimi external security audit

Branch `stage1/extract`, commit `harden: apply stage 1 kimi audit findings`.
Audit document: `docs/kimi-audit-stage1.md` (findings F-01…F-20, verdict FIX-FIRST
with F-01, F-05, F-02, F-03 blocking).

Every fix below has a test that fails against the pre-fix code and passes after
(fail-before verified by stashing the product change and re-running the test).

## Finding → change → test

### Blocking

| Finding | Change (file) | Test |
| --- | --- | --- |
| F-01 publish state machine wedge | `src/db.ts` — `claimPublish(maxAttempts, staleMs)` also reclaims `publishing` rows whose `updated_at` is older than the stale window (same `FOR UPDATE SKIP LOCKED` subselect; `attempts < max` still required); new `failExhaustedPublishes()` moves exhausted `retry`/stale-`publishing` rows to terminal `failed`. `src/config.ts` — `JEB_PUBLISH_STALE_MS` (default 120000). `src/publish.ts` — tick sweeps exhausted rows and passes the stale window; reclaimed rows flow through `publishOne`, whose existing `existingReply`-by-parent reconcile records a pre-crash successful PUT as published instead of re-publishing | `src/publish.test.ts` — "crash after PUT" (stale `publishing` row + post already in the homeserver list double → 0 new PUTs, exactly one reply, mention recorded `published` with the existing reply URI); "crash before PUT" (→ reply eventually published, no re-dequeue); fresh `publishing` row not reclaimed; exhausted row → `failed`, never re-claimed |
| F-05 reconcile must not fail open | `src/homeserver.ts` — `SessionTransport.listPosts()` no longer swallows errors: list/getJson errors propagate (publish loop retries with backoff). Pages newest-first (`reverse: true`) past the old 200 cap until the parent is found (`untilParent` early exit) or the listing is exhausted, bounded at 25 pages (5000 posts). Only `404 Directory Not Found` (pre-first-PUT) is treated as a definitive empty listing (`isDirNotFound`) — anything else is "unknown" and fails closed | `src/homeserver.test.ts` — list error propagates (also via `existingReply`); per-post fetch error propagates; newest-first paging past 200 with cursor; early exit on `untilParent`; dir-not-found → empty. `src/publish.test.ts` — list failure → no publish, row stays `retry`; list success after failure → exactly one PUT |
| F-02 profiling denylist bypass | `src/scout/guard.ts` — `hasIdBoundUser()` covers `(:User {id:…})`, `(u:User {id:…})`, `WHERE u.id = …`, `u.id IN […]`; rules apply independently: id-bound user + `AUTHORED` + post body (`.content`/`.attachments`) → reject; id-bound user + node `collect()` (non-aggregate) → reject (replaces dead rule 2 — the old `!LIMIT` condition could never fire because `LIMIT` is mandatory); `>maxProps` user props + traversal → reject. `JEB_SCOUT_RAW_ENABLED` default stays 0 (`config.ts:131` unchanged) | `src/scout/scout.test.ts` — audit Q4 bypass corpus added: WHERE-bind profiling (F-02a), content-only collect (F-02b), node collect (F-02c), `IN`-bind, few-props content collect — all REJECT; aggregate `size(collect())` and ids-only stay ALLOW |
| F-03 unscreened tool output | `src/tool-screen.ts` (new) — `screenToolResult()` deep-walks any tool result, caps each string field at 10000 chars, runs `InjectionDetector` over every string field, replaces detected instruction patterns with the sanitized form and returns flags. `src/answer.ts` — every wrapped tool (Nexus tools, all Scout tools, `search_knowledge`) screens its result before the model sees it; flags are pushed into the tool trace, which `reason.ts` persists in the evidence bundle (`evidence.tool_trace`). Knowledge corpus: `src/knowledge/ingest.ts` marks each chunk `suspect_injection` in metadata at ingest; `src/knowledge/store.ts` down-ranks suspect chunks at retrieval (`SUSPECT_SCORE_FACTOR = 0.25`) | `src/tool-screen.test.ts` — injected README fixture (`tests/knowledge/fixtures/injected/README.md`) detected + sanitized in nested fields with flag paths; length cap flagged; clean payloads untouched. `tests/knowledge/knowledge.test.ts` — injected fixture ingested → `suspect_injection=true` (clean twin `false`); retrieval returns both but ranks the suspect chunk below its near-identical clean twin |

### Fixed in the same pass

| Finding | Change (file) | Test |
| --- | --- | --- |
| F-04 redirects | `src/http.ts` — `redirect: "error"` on every configured-host fetch (Nexus + Scout clients both go through `fetchJson`/`postJson`); `src/knowledge/ingest.ts` HTTP source fetch likewise | `src/audit-hardening.test.ts` — 302 off-host → rejects; `tests/knowledge/knowledge.test.ts` — 302 source → rejects |
| F-06 search_knowledge gate/pool | `src/knowledge/tool.ts` — `createSearchKnowledgeExecute({pool, databaseUrl, mentionKey})`: shared caller pool when provided (per-call pool only as standalone fallback, still closed after use); `src/answer.ts` — wrapped in the same generation-switch gate as every other tool | `tests/knowledge/knowledge.test.ts` — execute with shared pool returns chunks and the pool stays usable afterwards |
| F-07 signup token in child env | `src/keys.ts` — `stripKeyMaterialEnv()` sweeps all `PUBKY_BOT_*` and `JEB_SIGNUP_TOKEN`; used by `src/main.ts` and `src/contract-adapter.ts` for ingest/reason children | `src/audit-hardening.test.ts` — strip test |
| F-08 case-sensitive markers | `src/knowledge/gate.ts` — `CONFIDENTIAL` and `Synonym 2026 Budget` markers now case-insensitive | `tests/knowledge/knowledge.test.ts` — "Confidential", "confidential", "synonym 2026 budget" all refused |
| F-09 HTTP source fetch bounds | `src/knowledge/ingest.ts` — 30 s `AbortSignal.timeout`, 2 MiB cap, text-ish content-type allowlist (overridable via opts for tests) | `tests/knowledge/knowledge.test.ts` — octet-stream rejected, over-cap rejected, hung source aborts, markdown accepted |
| F-11 cursor past unprocessed | `src/ingest.ts` — `ingestOne()` returns whether the item was processed (only a store outage counts as unprocessed); new `maxProcessedTs()` stops the cursor just below the oldest unprocessed item; first-boot stale-skipped items still count as processed | `src/audit-hardening.test.ts` — cursor math (partial/all/none processed, first boot), `ingestOne` false on dead store |
| F-12 publish after skip/fail | `src/publish.ts` — `publishOne` skips **only** when the mention is `skipped` or `failed` (not any non-`processing` status). Reason leaves the mention `processing` after `insertPublishRequest`; the publisher marks `published`. | `src/publish.test.ts` — skipped → 0 PUTs; failed → 0 PUTs; processing → 1 PUT |
| F-13 per-step budget | `src/answer.ts` — optional `budgetExceeded` gate checked before `generateText` and before every wrapped tool call (i.e. before each tool-loop model step); `src/reason.ts` passes the daily-ceiling check | `src/audit-hardening.test.ts` — budget-exceeded gate rejects before the model step |
| F-16 unbounded varlen paths | `src/scout/guard.ts` — `hasUnboundedVarlenPath()` rejects `[*]`, `[*..]`, `[*N..]` inside relationship brackets (bounded `*N`, `*..N`, `*N..M` allowed); checked only inside `[...]` so `count(*)` is unaffected | `src/scout/scout.test.ts` — `[:REPLIED*]` and `*2..` REJECT; `*1..3`, `*..3` ALLOW |

### Queue / publisher contract regressions (this pass)

| Issue | Change (file) | Test |
| --- | --- | --- |
| Re-delivery while `processing` enqueued a second reason job | `050_work_queue_dedupe.sql` — partial unique index on `work_queue(mention_key) WHERE status IN ('queued','claimed')`; `enqueueWork` `ON CONFLICT … DO NOTHING` returning whether inserted; `ingestOne` does not enqueue when active work **or** an active/published `publish_requests` row exists | `src/audit-hardening.test.ts` — second ingest while processing keeps one active work row; ingest after `finishWork` + queued publish does not enqueue |
| Duplicate `insertPublishRequest` | Partial unique index on `publish_requests(mention_key) WHERE status IN ('queued','retry','publishing','published')`; insert is a no-op on conflict | same file — second insert (and insert after `published`) returns false, one row, original content |
| Publisher skipped HAPPY mentions | F-12 was implemented as `status !== "processing"`; a mention that stayed claimed-but-not-that-string (or raced) skipped the PUT. Now only `skipped`/`failed` skip | `src/publish.test.ts` processing → PUT |

### Accepted for staging (documented, not fixed)

F-10, F-14, F-15, F-17, F-18, F-19, F-20 — see the Disposition section in
`docs/kimi-audit-stage1.md`.

## Proof

- `npx tsc --noEmit` — pass
- `DATABASE_URL=postgres://johncarvalho@127.0.0.1:5432/jeb_stage1_test JEB_KNOWLEDGE_TEST_DATABASE_URL=postgres://johncarvalho@127.0.0.1:5432/jeb_knowledge_unit JEB_EVAL_DATABASE_URL=postgres://johncarvalho@127.0.0.1:5432/jeb_eval JEB_MODEL_CACHE=/Volumes/vibedrive/vibes-dev/pubky-ai-bot-jeb/.cache/jeb-models npm test` — **22 files, 169 passed, 1 skipped** (live-scout opt-in)
- `npm run build && npm run build:contract` — pass; `dist/` still contains no `contract-adapter.js`
- External contract (staging homeserver, `JEB_CONTRACT_MODE=1`, `dist-contract/contract-adapter.js`) — **19/19 passed** (Vitest: 3 files, 19 tests, ~111s). HAPPY one-reply and EDGE start/end re-delivery both green.

Fail-before verification: with `src/db.ts`/`src/publish.ts`/`src/homeserver.ts`/`src/scout/guard.ts`
stashed, the new F-01 (×3), F-12, F-05 (×3) and guard-corpus tests fail; with the
changes restored they pass.

### Contract regression caught during remediation

The first F-05 implementation propagated *all* list errors, including the
homeserver's `404 Directory Not Found` for a brand-new bot whose posts
directory does not exist yet — that deadlocked first-ever publishes (staging
contract run showed every `publish_requests` row exhausting attempts with
`404 … Directory Not Found`). Fixed by treating only that error as a
definitive empty listing (`isDirNotFound`); every other list error still
propagates.

A later pass that re-enqueued on every `processing` re-delivery produced two
replies on EDGE start/end; tightening F-12 to `status !== "processing"` then
produced zero replies on HAPPY. Fixed by partial unique indexes + idle-only
re-enqueue, and by skipping the PUT only for `skipped`/`failed`.

`listPosts` pages at 200 items, at most 25 pages, and stops once `untilParent`
is found. The contract adapter does not set `JEB_PUBLISH_STALE_MS` (default
120000).

A follow-up commit `fix: run migrations once before spawning roles` runs
`Store.migrate()` in the `--role all` parent, sets `JEB_SKIP_MIGRATIONS=1` on
children, and serializes `DatabaseMigrator.runMigrations` with
`pg_advisory_lock(746283901)`. `src/migrator.test.ts` runs two concurrent
migrates on a fresh database.
