# Kimi Re-audit A4r — NL query service after remediation

**Repo:** detached at d479d0c · **Scope:** `.ai/step14-fix.diff` (1428 lines, read in full) + direct reads of `packages/bot-kit/src/nlq/{env,http,service,planner,process,tool-deps,types,index}.ts`, `scout/{client,budget,schema-cache,circuit,tools,scout-config}.ts`, `nexus/tools.ts`, `security/keys.ts`, `log.ts`, `http.ts` (kit), `src/main.ts`, `src/db.ts`, `src/switches.ts`→`policy/switches.ts`, `migrations/030_scout.sql`, `docs/nlq.md`, `.env.example`, and all three touched test files (`nlq/process.test.ts`, `nlq/service.test.ts`, `nlq/tool-deps.test.ts`). Read-only; no files modified, no git writes, no network, no tests run (DB-dependent).

**Verdict: FIX-FIRST**

All four Medium findings from A4 are genuinely fixed with real tests, and the low/info items are addressed as claimed. However, the F-4 remediation introduces one new Medium availability defect: the per-mention cap it newly activates counts **all-time** rows against a **persistent** caller key, so the service permanently locks itself out after ~12 successful queries (≈2 `profile_card` calls) per key — and the new 200/day NLQ ceiling can never be reached. One-line SQL fix. Nothing in the remediation weakens the default-confidentiality posture (no key material, fail-closed schema, no raw Cypher, static error reasons all hold).

---

## F-1..F-13 status

 Finding | Status | Evidence (file:line) | Named test asserts the property? |
---|---|---|---|
 F-1 unvalidated bind | **FIXED** | `nlq/env.ts:14-19` (`net.isIP`, `"localhost"` rejected), `env.ts:4` (loopback = `127.0.0.1`/`::1` only), `env.ts:25-35` (danger opt-in + `log.warn`), `process.ts:28-31` (`isLoopbackBind` actually called), `http.ts:73-74` (enforced again in `listenNlq`), `main.ts:191` | Yes — `process.test.ts:64-77` (rejects `/JEB_NLQ_BIND is not loopback/`), `79-94` (binds 0.0.0.0 with `JEB_NLQ_BIND_DANGEROUS=1`, asserts a "non-loopback" warn), `35` (`nlqBind("localhost")` throws) |
 F-2 per-request schema fetch | **FIXED** | `process.ts:33` (one startup refresh), `process.ts:34-41` (`ensureScoutSchemaCache` with the **shared** client), `planner.ts:60-63` (reads cache only, never fetches), `service.ts:131-137` (breaker checked **before** planning), `client.ts:89-100` (`schema()` behind breaker + the query token bucket), `service.ts:20,123-129` (client now required; per-request fallback gone) | Yes — `service.test.ts:165-184` (`stub.schemaGets` stays 1 across 5 requests), `186-200` (breaker open → `circuit_open`, `schemaGets === 0`, `calls === []`) |
 F-3 DB kill switch ignored | **FIXED** | `main.ts:203` (`storeSwitchOn: () => switchOnSql(pool, "scout")`), `src/db.ts:23` (export), `service.ts:139-146` (switch checked before planning; `scoutSwitchBlocked` also covers env `JEB_SWITCH_*`/`JEB_DISABLED`, `budget.ts:17-23`), plus per-call re-check in `createScoutTools.run()` (`tools.ts:236-240`) | Yes — `service.test.ts:203-229` (`switch_off`, `schemaGets === 0`, `calls === []`, switch reset in `finally`) |
 F-4 no per-caller budget | **PARTIAL** — mechanism wired, but activates an all-time cap (→ **F-N1**) | Caller key: `http.ts:57-70,106-107`; NLQ ceiling: `budget.ts:67-77`, `service.ts:173-182`; `asker` removed as budget key (`service.ts:184-190` passes no `author`) | Tests exist and assert the gates fire: `service.test.ts:231-257` (per-mention cap blocks, zero Scout calls), `259-289` (`LIKE 'nlq:%'` counts ok=FALSE rows too, excludes `reason-key`, ceiling 2 blocks). **Neither covers day rollover** — see F-N1 |
 F-5 internal error reflection | **FIXED** (one residual channel → F-N3) | `service.ts:63-92` (`reasonForCode`/`nlqPublicReason` — all static), `service.ts:94-111` (`mapToolError` static), `http.ts:113-122` (catch-all now `"internal error"` + server-side `log.warn`), `client.ts:20-34` (`toPublic()` static for every code), `client.ts:207` (upstream `message` no longer forwarded), kit `http.ts:41` (400-byte body echo → `"non-json response"`) | Yes — `service.test.ts:291-311` (`nlqPublicReason` strips `10.0.0.5`; end-to-end `tool_error`/`internal error`, no address) |
 F-6 no zod validation of tool args | **FIXED** | `service.ts:214-222` (`tool.parameters.safeParse(call.args)`; failure → static `unsupported`), `service.ts:225` (executes `parsed.data`, matching AI SDK semantics — the answer loop hands the *same* schema objects to `tool({parameters})`, `answer/tool-loop.ts:216-220`), `tools.ts:179` + `tools.ts:212` (`asker` Z32-constrained). Nexus tools covered: all have zod `parameters` (`nexus/tools.ts:30,40,51,59,67,80`) | Yes — `service.test.ts:313-326` (`hops: 99` → `unsupported`/`tool arguments are invalid`, `calls === []`), `328-341` (malformed `asker` likewise) |
 F-7 bind/port edge cases | **FIXED** | `env.ts:37-40` (`nlqHttpBase` brackets IPv6), `http.ts:78,136` (used for URL base + listen url), `env.ts:6-12` (port int 1–65535, named `invalid JEB_NLQ_PORT`) | Yes — `process.test.ts:96-114` (`/healthz` 200 over `http://[::1]:…`), `116-121` (garbage/0/65536 throw the named error) |
 F-8 unauthenticated `asker` / budget `author` | **FIXED** | `docs/nlq.md:36-39,129` (`asker` documented as unauthenticated hint), `service.ts:184-190` (no `author` passed to `createScoutTools`; budgets keyed on `mentionKey` only) | Doc + F-4 tests, as claimed; verified no budget path reads `asker` |
 F-9 `profile_card` deps incomplete | **FIXED** | `tool-deps.ts:95-105` (all seven templates listed) | Yes — `tool-deps.test.ts:53-59` (exactly 7, contains the three previously missing), `61-128` (executes every Scout tool against a stub and asserts every emitted Cypher's refs ⊆ `cyphersForTool` refs) |
 F-10 ALL-CAPS check overstated | **FIXED** (doc-only) | `docs/nlq.md` Planner step 3: "Best-effort UX … not a security boundary" | n/a |
 F-11 soft budget ceiling | **NOT FIXED** (explicitly accepted in A4; unchanged) | `budget.ts:30-44` (count-then-insert, no locking); multi-query tools unchanged; the new `checkNlqDailyBudget` (`budget.ts:68-77`) inherits the same race | — |
 F-12 request hardening | **FIXED** | `http.ts:24-26,125-127` (`requestTimeout` 30s / `headersTimeout` 10s / `maxConnections` 128; headers < request, valid pairing), `planner.ts:12-41` (duplicate `"THE"` removed) | Constants verified by reading; no behavioral test (as declared) |
 F-13 doc/ordering nits | **FIXED** (doc-only) | `docs/nlq.md` process section now "before any key-dependent initialization"; minimal-env list added (`docs/nlq.md` §"Minimal env for the nlq unit"). Ordering itself unchanged and still safe: `main.ts:181-182` assert runs before pool (`:188`) and migrations (`:190`) | n/a |

---

## New findings (introduced or surfaced by the remediation)

### F-N1 — Per-mention cap is an *all-time* cap on a *persistent* NLQ caller key → permanent service lockout (Medium)
**`packages/bot-kit/src/scout/budget.ts:36-44`** (per-mention count has **no `created_at` window**), activated by **`nlq/http.ts:106-107, 57-70`** (persistent keys `nlq:127.0.0.1` / `nlq:::1` / `nlq:token`), default cap 12 (`src/config.ts:239`), table has no TTL and **no production code ever deletes `scout_queries`** (grep-confirmed: only tests `DELETE`; `migrations/030_scout.sql`).
**Impact:** For the reason loop, `mention_key` is unique per mention, so "all-time" ≈ "per mention" — correct. NLQ reuses the same key forever, and **all** untokened loopback callers share one key (`nlq:127.0.0.1`). After 12 cumulative `ok=TRUE` rows the gate returns `budget_exhausted` *permanently*, for every local caller, until an operator manually deletes rows. One `profile_card` with `asker` writes up to 7 ok rows (`tools.ts:1188-1235`: snap/followers/following/tags-received/tags-applied/replied-to + mutual) — so **two profile_card requests kill the service for good**. It also makes `JEB_NLQ_DAILY_QUERIES=200` unreachable dead config (12 < 200, and the 12 never reset). The F-4 test (`service.test.ts:231-257`) actually bakes in the all-time semantics and would not catch a day-boundary regression.
**Fix:** add `AND created_at >= date_trunc('day', now())` to the per-mention count in `checkScoutBudgets` (making it per-day per key — harmless for reason, correct for NLQ), or skip the per-mention cap for `mention_key LIKE 'nlq:%'` and rely on the NLQ daily ceiling. Add a test that a key at cap is served again "tomorrow" (insert rows with backdated `created_at`).

### F-N2 — `JEB_NLQ_TOKEN` compared with `===` (non-constant-time) (Low)
**`packages/bot-kit/src/nlq/http.ts:62`** (`bearer === configured`). A timing oracle over the network (only relevant when `JEB_NLQ_BIND_DANGEROUS=1` exposes the port). Blast radius is small — the token only re-keys budgets, it grants nothing (F-N6) — but it is a secret comparison and should be constant-time. Note the token is otherwise handled cleanly: read once (`http.ts:58`), never logged (pino redact `log.ts:13-15` plus `*.authorization` at `:21`), never reflected, and **never stored raw** — a match yields the literal key `"token"` → `mention_key = 'nlq:token'` (`http.ts:62,68-70`; rows written at `client.ts:204,242`). Also: no test exercises `nlqCallerKey` at all (bearer match/mismatch, `::ffff:` unwrap).
**Fix:** `crypto.timingSafeEqual` over equal-length buffers (hash both sides with SHA-256 first to normalize length); add a unit test for match → `nlq:token`, mismatch → IP key.

### F-N3 — Upstream Scout `error` code string is still reflected to the caller (Low)
**`client.ts:194`** (`code` = upstream `err.data.error`, arbitrary `z.string()`) → flows into `results[].error` and `toolTrace[].result.error` at **`service.ts:238,245`**. F-5's fix made every *message* static, but this code channel remains: a hostile/compromised gateway (or anything that can influence its error payloads) can put an arbitrary string into an NLQ response body. Only the mapped `reason` is static.
**Fix:** in the `isPublicToolError` branch, emit `{ error: mapped-static-code, message: mapped.reason }` (or whitelist known codes); keep the raw upstream code in `scout_queries.error_code` only. Related nit: the reason-loop model now also loses the `(per_mention_scout_cap)` hint suffix since `toPublic()` is fully static (`client.ts:20-34`) — acceptable, but deliberate.

### F-N4 — Kill switch does not stop schema fetches (Info)
**`process.ts:33`** (startup refresh) and **`schema-cache.ts:161-169`** (TTL tick → `client.schema()`) check the breaker (`client.ts:90`) but never the switch. While the `scout` switch is on, the NLQ process still `GET /v1/schema` every `JEB_SCOUT_SCHEMA_REFRESH_MS`. All *query* paths are correctly blocked (verified: `service.ts:139-146` pre-plan + `tools.ts:236-240` per call; test `service.test.ts:203-229`), and the reason process behaves the same way, so this is consistency-neutral — but "refuses tools" ≠ "stops contacting Scout", worth knowing during an incident.
**Fix (optional):** skip the tick when `scoutSwitchBlocked` is true.

### F-N5 — `JEB_NLQ_TOKEN` added to `REASON_ALLOWLIST` (Info)
**`packages/bot-kit/src/security/keys.ts:145`.** The env-scrubbed reason child now inherits a shared secret it never uses — the allowlist's purpose is minimal child surface, and the NLQ process reads `process.env` directly in the main process, so no child needs this name. (`JEB_NLQ_BIND_DANGEROUS`/`JEB_NLQ_DAILY_QUERIES` additions are harmless non-secrets.)
**Fix:** drop `JEB_NLQ_TOKEN` from `REASON_ALLOWLIST` (or introduce a separate NLQ list if a child role is ever added).

### F-N6 — The token is not authentication, and nothing says so loudly (Info)
**`http.ts:57-66`:** requests with no/wrong bearer are still served (IP-keyed). With `JEB_NLQ_BIND_DANGEROUS=1`, the full read catalog is public and the token merely shifts which budget bucket a caller drains. `.env.example:85` says "used only as an NLQ caller key", but `docs/nlq.md` never states "does not gate access". An operator may believe they added auth.
**Fix:** one doc sentence; optionally, when `JEB_NLQ_TOKEN` is set *and* the bind is non-loopback, refuse requests without a matching bearer (403 typed outcome).

### F-N7 — Schema-cache lifecycle nits (Info)
**`schema-cache.ts:137-148`:** a failed refresh keeps the last live schema with `source = "live"` indefinitely (retries each interval) — planner serves a possibly hours/days-stale schema. This matches ADR 0003:69 ("has succeeded this process") and the A4 F-2 fix design, so **fail-closed is preserved** (`planner.ts:60-63,228-235`; golden is never planned from) — noted, not a defect. Availability edge: a process started while Scout is down gets one immediate retry (`schema-cache.ts:166`, `source !== "live"` → `tick()`), then nothing until the full interval (default 6 h) even if Scout recovers sooner.
**Fix (optional):** shorter retry backoff while `source !== "live"`.

---

## Verified properties (confirmed holds at d479d0c)

- **No key material.** `assertNoKeyMaterial()` at `main.ts:181-182` (before pool/migrations) and `process.ts:27`; nlq config never reads secrets; test `process.test.ts:49-62` retained.
- **No write path.** No `PublishStore`/publish references in `nlq/`; DB writes remain `scout_queries` accounting + migrations only.
- **Schema fail-closed preserved under the TTL cache.** `planner.ts:60-63, 228-235`; source starts non-`live` and only the first successful fetch flips it; test `service.test.ts:50-66` (`schema_unavailable`, zero Scout calls).
- **Switch honored end-to-end with zero egress.** Service-level check (`service.ts:139-146`) + per-tool re-check (`tools.ts:236-240`); test proves `schemaGets === 0` and `calls === []` (`service.test.ts:203-229`). Only residual: schema TTL tick (F-N4).
- **New daily-count query is injection-free and prefix-correct.** `budget.ts:68-77`: constant `LIKE 'nlq:%'` (no `_` in pattern, trailing `%` only), numeric ceiling compared in JS, parsed as int ≥1 (`env.ts:42-48`). Day boundary uses the identical `date_trunc('day', now())` expression as the existing daily ceiling (`budget.ts:31` vs `:71`) — same DB-session timezone, consistent. No collision with reason keys (reason `mention_key` = mention post URIs, `src/reason.ts:155`; NLQ keys always `nlq:`-prefixed, `http.ts:68-70`).
- **`JEB_NLQ_TOKEN` hygiene.** Read only at `http.ts:58`; never logged (redact paths `log.ts:13-15`); never reflected; never stored raw — `scout_queries.mention_key` only ever sees `nlq:token` / `nlq:<ip>`. (Compare is non-constant-time — F-N2.)
- **`safeParse` gating uses the same schemas as the AI SDK path.** The answer loop passes the identical `parameters` objects into `tool({…})` (`answer/tool-loop.ts:216-220`); NLQ parses with them and executes `parsed.data` (`service.ts:214-225`). Nexus tools are covered (all zod `parameters`, `nexus/tools.ts`). Un-registered-tool path is a static string (`service.ts:206-213`).
- **No `e.message` / upstream-body reflection in any response path** (all branches traced: http catch-all, planner catch, tool catch, `mapToolError`, `toPublic`, non-JSON helper). Residual: upstream error *code* string (F-N3).
- **Raw Cypher posture unchanged.** Planned only for Cypher-shaped questions with `rawEnabled` (`planner.ts:128-132`), else `guard_rejected` with no Scout call (`planner.ts:258-264`); `query_graph` has no `cyphersForTool` entry and still re-runs `guardRawCypher` at execution.
- **SSRF posture unchanged.** `assertScoutUrl` pins host per request (`client.ts:83-87`); `redirect: "error"` (kit `http.ts:34`); request input never becomes a fetch URL.
- **Bind/port hardening.** `net.isIP` validation, loopback-only default, dangerous opt-in warns at startup and listen; IPv6 URL base; named port errors (`env.ts:6-40`, `process.ts:28-31`, `http.ts:73-75,136`).
- **Intent byte-identity untouched** (no `intent.ts` changes in the remediation diff).
- **Allowlist additions carry no secrets** except the deliberate `JEB_NLQ_TOKEN` (F-N5).

## Not covered

- **No test execution** (read-only audit; suites need live Postgres). All assessments are static; no `tsc`/build run either.
- **`nlqCallerKey` has no direct test** — bearer match → `nlq:token`, mismatch → IP fallback, `::ffff:` unwrap are unverified by the suite (F-N2).
- **No day-rollover test for any budget** — precisely the gap that lets F-N1 ship.
- Reason-loop impact of fully static `toPublic()` messages (model sees less budget detail) — read but not behaviorally assessed.
- Upstream Scout gateway / Neo4j, Nexus REST backend (trusted-dependency assumption, unchanged from A4); a compromised schema response still weakens the raw guard's schema-bound check.
- `JEB_DB_URL_REASON` PG-role least-privilege in real deployments — still open from A4.
- Uncommitted working-tree change (`.gitignore` + `.audit/`) — outside the audited commit.
- Concurrency of the new NLQ daily gate (same check-then-act class as F-11) — static review only.

## Remediation (A4r) 2026-09-04

| Finding | Change | Test |
| --- | --- | --- |
| F-N1 | Skip `JEB_SCOUT_PER_MENTION_CAP` for `mention_key` starting with `nlq:`. `checkNlqDailyBudget` now counts today for the caller key (`mention_key = $key`) and today globally (`LIKE 'nlq:%'`). Reason-loop keys unchanged. | `service.test.ts`: yesterday's rows at cap are served today; two `profile_card` calls (7 ok rows each) plus a third query succeed; global `nlq:%` ceiling still blocks; per-caller daily ceiling blocks; reason-loop all-time cap still blocks |
| F-N2 | `nlqCallerKey` compares bearer vs `JEB_NLQ_TOKEN` with `crypto.timingSafeEqual` over SHA-256 of both sides. | `process.test.ts`: match → `nlq:token`; mismatch → IP key; `::ffff:127.0.0.1` unwraps to `127.0.0.1` |
| F-N3 | `publicScoutErrorCode` whitelists known Scout codes; unknown → `"upstream_error"`. Response `results[].error` / `toolTrace[].result.error` use the mapped code. Raw string stays in `scout_queries.error_code`. | `service.test.ts`: stub `{error: "10.0.0.5 leaked"}` is absent from the response body; DB row keeps the raw code |
| F-N4 | `runNlqProcess` skips the startup schema refresh when `scoutSwitchBlocked`; `ensureScoutSchemaCache` ticks skip `client.schema()` in that state. | `process.test.ts` + `schema.test.ts`: switch on → zero schema fetches including after a tick |
| F-N5 | `JEB_NLQ_TOKEN` removed from `REASON_ALLOWLIST`. `--role nlq` is in-process (`src/main.ts`); no `NLQ_ALLOWLIST` child needed. | `keys.test.ts`: token absent from reason child env; `main.ts` has `role === "nlq"` and no `spawnRole("nlq"` |
| F-N6 | When `JEB_NLQ_TOKEN` is set and the bind is non-loopback, missing/wrong bearer → HTTP 403 `outcome: "unauthorized"`, reason `"unauthorized"`. Loopback without token (or without bearer) still served. | `process.test.ts`: dangerous bind 403; loopback 200 without bearer |
| F-N7 | While `source !== "live"`, schema-cache retries 30s → 60s → 120s, cap 5 min, instead of the full refresh interval. | `schema.test.ts` fake timers: second fetch at 30s, third at 90s; not deferred to the 6h interval |
