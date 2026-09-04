# Kimi Audit A4 — NL query service (step 14)

**Repo:** detached at 4a8c299 · **Scope:** `.ai/step14.diff` (1720 lines) + full context read of `packages/bot-kit/src/nlq/`, `scout/` (client, guard, templates, tools, budget, limiter, circuit, schema-cache/-deps/-refs/-model), `security/keys.ts`, `src/main.ts`, `src/config.ts`, `src/intent.ts`, `src/reason.ts`/`answer.ts`/`tool-loop.ts`, `docs/nlq.md`, `docs/adr/0003-nl-query-safety-policy.md`. Read-only; no files modified, no tests run (DB-dependent), no network.

**Verdict: FIX-FIRST**

Nothing remotely exploitable in the *default* configuration (loopback bind, raw off, no key material, schema fail-closed holds). But four Medium gaps — unvalidated bind on an unauthenticated service, a per-request unthrottled schema fetch to the shared Scout gateway, the DB kill switch not being honored, and a silently-inapplicable per-caller budget — should be fixed before this process serves anything beyond a single trusted loopback consumer.

---

## Findings

### F-1 — `JEB_NLQ_BIND` is unvalidated; loopback "enforcement" is dead code on an unauthenticated service (Medium)
**`packages/bot-kit/src/nlq/http.ts:37-44, 98`; `src/main.ts:194`; `packages/bot-kit/src/nlq/process.ts:37`**
`nlqBind()` returns any non-empty string verbatim; `isLoopbackBind()` is defined (`http.ts:42`) and exported (`index.ts:25`) but **never called** anywhere in the production path (grep-confirmed: only the export sites reference it). `JEB_NLQ_BIND=0.0.0.0`, `::`, or a public interface address is accepted silently, and the service has **no authentication** on `/v1/query` — the entire read catalog (person-profiling-adjacent tools: `trust_view`, `profile_card`, `mentions_of`), plus the `query_graph` hatch if the operator ever enables `JEB_SCOUT_RAW_ENABLED`, becomes network-reachable with no token, no TLS, and not even a startup warning. The threat model says "loopback by default"; that holds, but one env var widens it with zero friction and zero logging.
**Fix:** at startup (`runNlqProcess`), refuse non-loopback binds unless an explicit second opt-in (e.g. `JEB_NLQ_BIND_DANGEROUS=1`) is set, and `log.warn` loudly either way. Actually call `isLoopbackBind`. Validate with `net.isIP` rather than the `LOOPBACK` string set (`"localhost"` can resolve off-loopback; see F-7). If non-loopback is ever intended, require a bearer token.

### F-2 — Every request forces a schema fetch that bypasses the limiter, budget, and breaker (Medium)
**`packages/bot-kit/src/nlq/planner.ts:48-53, 230`; `packages/bot-kit/src/scout/client.ts:84-88`; `packages/bot-kit/src/nlq/service.ts:101`**
`loadPlannerSchema()` calls `refreshScoutSchema(client)` on **every** `/v1/query` (there is no TTL gate — `ensureScoutSchemaCache` is never started by `runNlqProcess`, `process.ts:28-30` does one startup refresh only). `client.schema()` (`client.ts:84-88`) does a bare `fetchJson`: no `bucket.acquire` (the `JEB_SCOUT_MAX_QPS` token bucket is only in `query()`, `client.ts:103`), no `scoutBreakerBlocked()` check, no `scout_queries` row. And the breaker pre-check in `service.ts:101` runs **after** planning, i.e. after the schema fetch. Net effect: any unauthenticated caller can loop POSTs and force one unthrottled, unbudgeted `GET /v1/schema` per request against the shared production Scout gateway (public 50 rps cap shared with everyone) — even while the circuit is open, the daily budget is exhausted, or the switch is flipped. This both hammers the gateway the whole system depends on and inflates the caller's effective request amplification (1 HTTP in → 1-8 Scout calls out).
**Fix:** start the TTL schema cache in the NLQ process (`ensureScoutSchemaCache`) and have the planner read `getActiveScoutSchema()` + `getScoutSchemaSource()` instead of refreshing per request (fail-closed is preserved: source stays non-`live` until the first success). Check the breaker before planning. Route `schema()` through the same token bucket.

### F-3 — The documented DB kill switch (and canary auto-trip) does not stop NLQ (Medium)
**`packages/bot-kit/src/nlq/service.ts:115`; `src/main.ts:189-198`; contrast `src/reason.ts:70, 453`**
The answer loop wires `storeSwitchOn: () => store.switchOn("scout")` (reason.ts:453), which is both the operator kill switch (`docs/killswitch-drill.md`, ADR 0003:17) and the `ScoutWriteCanary` auto-trip (reason.ts:70). `runNlqProcess` accepts `storeSwitchOn` (`process.ts:26`) but `main.ts:189-198` never passes it, so NLQ falls back to `?? (async () => false)` (service.ts:115) and only honors **env** switches (`defaultScoutEnvSwitchOn`, scout-config.ts:35-40) — which require a process restart to change. During an incident, an operator flipping the `scout` switch stops the reason process but NLQ keeps serving graph queries (bounded only by budget/circuit). This contradicts the drill's "refuses tools" guarantee for the new consumer.
**Fix:** in the `nlq` branch of `main.ts`, build a switch reader over the existing pool (`switchOnSql` from `src/db.ts:20`) and pass `storeSwitchOn: () => switchOnSql(pool, "scout")`.

### F-4 — No per-caller budget: per-mention cap silently skipped, shared daily ceiling drainable (Medium)
**`packages/bot-kit/src/scout/budget.ts:30-44`; `packages/bot-kit/src/nlq/service.ts:113`; `src/main.ts:189-198`**
`checkScoutBudgets` applies the per-mention cap only `if (opts.mentionKey)` (budget.ts:36). NLQ production passes no `mentionKey`, so the 12-query cap is skipped; the only brakes are the global 400/day ok-TRUE ceiling (shared, via the same `scout_queries` table, with the reason answer loop) and the 2 qps bucket. Any local process — or any network peer if F-1 is misconfigured — can loop requests and burn the entire daily Scout budget, starving real Jeb answers (`budget_exhausted`), at ~2 qps × multi-query tools (one `profile_card` = 7 ok-TRUE rows per single budget check). `docs/nlq.md:17` claims "per-mention/daily Scout budgets … apply" — per-mention does not.
**Fix:** add a caller-keyed cap (API token from F-1, or client IP on loopback) recorded as `mention_key`, or give NLQ its own daily ceiling separate from the reason budget. At minimum, correct `docs/nlq.md:17`.

### F-5 — Internal error details are reflected to the caller in `reason` (Low)
**`packages/bot-kit/src/nlq/http.ts:84-93`; `packages/bot-kit/src/nlq/service.ts:84-89, 148-158`; `packages/bot-kit/src/scout/client.ts:195`; `packages/bot-kit/src/http.ts:41`**
Three layers serialize `e.message` into the response: the http catch-all (200 `tool_error`), the planner catch, and the tool-execute catch. Messages that can leak: pg errors from `client.record()` failure (`connect ECONNREFUSED 10.0.0.5:5432` — internal DB address), upstream Scout `message` echoed verbatim (client.ts:195), and up to 400 bytes of a non-JSON upstream response body (http.ts:41). No stacks are leaked (verified — only `.message`), but this violates the threat model's "not leak env/config/internal paths in responses" and gives an unauthenticated caller an internal-infrastructure oracle.
**Fix:** map known error codes to static reason strings server-side; log the raw `e.message` only. Never forward upstream `message`/body.

### F-6 — Tool args are never zod-validated in the NLQ path (Low — currently safe, load-bearing defense removed)
**`packages/bot-kit/src/nlq/service.ts:147`**
The answer loop gets arg validation for free from the AI SDK (`tool({ parameters, execute })`, `tool-loop.ts:216-220`); NLQ calls `tool.execute(call.args as never)` directly, so the zod schemas on `tools.ts` (`graphScopeSchema` hops 1-3, `timeRangeSchema` nonnegative ints, `trustViewParams` refinement, etc.) are bypassed for request-controlled `scope.*` and `asker`. I verified there is **no live hole today**: `topicPostsTemplate`/`emergingWindowTemplate`/trust-view/follow-path clamp interpolated hops via `clampBound` (templates.ts:33-36, 158, 300, 489, 505 — a string `hops` falls back to 1), all question-derived text is bound as `$params` (templates.ts:48-55, 162-168, 337), and `parseUserPk` throws on bad askers (tools.ts:7-11). But the templates' own comment ("zod enforces bounded ints", templates.ts:30) is now false for this caller — the next template that interpolates an unclamped value becomes a Cypher-injection hole that bypasses `guardRawCypher` entirely.
**Fix:** before `execute`, validate with the tool's own schema: `const parsed = tool.parameters.safeParse(call.args); if (!parsed.success) return unsupported`. One line of defense, restores the documented invariant.

### F-7 — Bind/port edge cases: `::1` serves 100% errors; port parsing accepts NaN (Low)
**`packages/bot-kit/src/nlq/http.ts:51`; `src/main.ts:193`; `packages/bot-kit/src/nlq/process.ts:36`**
With `JEB_NLQ_BIND=::1` (a *loopback* address, in the `LOOPBACK` set), the server listens fine but every request hits `new URL(req.url, "http://::1")` → throws `Invalid URL` → catch-all returns 200 `tool_error` forever; the service is up but dead, and only the log line hints why. `Number(process.env.JEB_NLQ_PORT || 3014)` yields NaN for garbage (`"3014abc"`), which `server.listen` rejects with a startup crash — acceptable, but the error message won't name the env var. `LOOPBACK` also contains `"localhost"`, which resolves via DNS and is not a guarantee.
**Fix:** validate `nlqBind` with `net.isIP` (accept `127.0.0.1`/`::1` only by default); build the URL base with brackets for IPv6; parse the port as an int in 1-65535 at config time with a named error.

### F-8 — Unauthenticated `asker` impersonation; budget `author` is caller-controlled (Low)
**`packages/bot-kit/src/nlq/planner.ts:146, 159`; `packages/bot-kit/src/nlq/service.ts:114`; `packages/bot-kit/src/scout/budget.ts:52-62`**
The answer loop derives `asker` from the authenticated mention author; NLQ takes it from the JSON body. Anyone can request `trust_view` "in *X's* network" or `profile_card` mutuals for arbitrary X (public follows/tags, but ADR 0003 §13 Q2 names person-profiling as the threat, and `docs/nlq.md:33` presents `asker` as "the asking user"). The same value is passed as `author` for the raw per-user budget (service.ts:114) — caller-controlled, and moot anyway: that cap JOINs `handled_mentions` on `mention_key` (budget.ts:53-56), which is NULL for all NLQ rows, so the per-user raw cap can never fire in NLQ (global 40/day backstops; raw is default-off).
**Fix:** document `asker` as unauthenticated in `docs/nlq.md`; don't key any budget on it; if raw is ever offered here, key the per-user cap on the F-4 caller identity.

### F-9 — `cyphersForTool("profile_card")` omits 3 of the 7 templates the tool executes (Info)
**`packages/bot-kit/src/nlq/tool-deps.ts:98-104` vs `packages/bot-kit/src/scout/tools.ts:1188-1219`**
The tool also runs `identityFollowersTemplate`, `identityFollowingTemplate`, `identityTagsTemplate`; the deps map lists only snapshot/tags_applied/replied_to/mutual. Today the missing deps (FOLLOWS, TAGGED, indexed_at) are covered transitively by the listed templates, so nothing escapes the check — but a future template edit can silently drift out of the `validateToolAgainstSchema` net that ADR 0003:69 relies on.
**Fix:** include all seven templates; add a test asserting `cyphersForTool` covers every `client.query` cypher a tool can emit.

### F-10 — ALL-CAPS relationship-token check is bypassable (Info — heuristic, not a boundary)
**`packages/bot-kit/src/nlq/planner.ts:9, 55-66, 239-248`**
`REL_TOKEN` only matches ASCII `[A-Z][A-Z0-9_]{2,}`: lowercase/mixed-case/unicode rel names in a question skip it, and it is skipped entirely for Cypher-looking questions (planner.ts:239). Confirmed this is **not** a security boundary: no question text ever reaches a Cypher identifier (typed tools use fixed templates; raw goes through `checkSchemaBound`, guard.ts:193-218). It can also over-block (`"ROI of pubky"` → `schema_unsupported`). Fine as UX; `docs/nlq.md:74` ("Reject questions that name relationship types absent") overstates it.
**Fix:** none required for safety; optionally document as best-effort in `docs/nlq.md`.

### F-11 — Budget ceiling is soft: check-then-act race + multi-query tools (Info, pre-existing)
**`packages/bot-kit/src/scout/budget.ts:30-44`; `packages/bot-kit/src/scout/client.ts:221`**
The count-then-insert pattern lets concurrent requests pass the gate simultaneously, and one tool execution adds up to 7 rows after a single check. NLQ inherits this from the reason loop; overshoot is bounded by the 2 qps bucket. Noted for the shared-state-correctness question; not a regression.

### F-12 — Request hardening relies on Node defaults; test-only stub is clean (Info)
**`packages/bot-kit/src/nlq/http.ts:14-30, 46-49`; `packages/bot-kit/src/nlq/stub.ts`**
Body is capped at 1 MB (http.ts:20) with `req.destroy()`; deep JSON nesting throws inside the same `try` → typed 400. No explicit `server.requestTimeout`/`headersTimeout`/`maxConnections` — Node ≥20 defaults (300 s/60 s) bound slowloris; engines require ≥20 (package.json:9), so acceptable but worth setting explicitly on an internet-facing process. `stub.ts` is imported only by `*.test.ts`, is not re-exported from `nlq/index.ts` (verified), and binds 127.0.0.1 — not reachable in production. `REL_NOISE` contains `"THE"` twice (planner.ts) — cosmetic. NLQ test files hardcode a local dev DSN (process.test.ts:13, service.test.ts:15) — matches pre-existing convention in 20+ test files; no secret.

### F-13 — Doc/ordering nits: `assertNoKeyMaterial` is not literally first; no NLQ env scrub (Info)
**`src/main.ts:83-84, 180-182`; `src/config.ts:168`; `packages/bot-kit/src/security/keys.ts:140-141, 171-176`; `docs/nlq.md:15`**
`configFromProcessEnv` (main.ts:84) runs before `assertNoKeyMaterial()` (main.ts:182), but with `requireSecret=false` it substitutes `"00".repeat(32)` and never calls `secretFromEnv` (config.ts:168) — so no key material is touched before the assert, and with `PUBKY_BOT_*` set the process still refuses to start (covered by process.test.ts:44-56). The doc claim is effectively true; the ordering is safe. Separately: unlike the reason child (allowlist-scrubbed `reasonChildEnv`, keys.ts:171-176), a directly-launched `--role nlq` process inherits the full operator env (`JEB_MODEL_API_KEY`, `ADMIN_TOKEN`, …). Nothing serializes env into responses (verified), but the process "holds" more than the threat model's minimal posture suggests.
**Fix:** doc tweak ("before any key-dependent initialization"); consider a documented minimal-env recommendation for the NLQ unit.

---

## Verified properties (confirmed holds)

- **No key material in the process.** `assertNoKeyMaterial()` runs in `main.ts:182` before pool/migrations/listen, and again first in `runNlqProcess` (`process.ts:28`); it rejects all three `PUBKY_BOT_*` vars (`keys.ts:29-37`). Config for `--role nlq` never reads secrets (`main.ts:83` → `config.ts:168`). Test: `process.test.ts:44-56`.
- **No write path.** No `PublishStore`/`publish_requests` reference anywhere in `nlq/` (grep; only a comment in `process.ts:16`); no homeserver session; DB writes are limited to `scout_queries` accounting rows (`client.ts:236-263`) and startup migrations (DDL, same as reason).
- **Schema fail-closed.** Planner refuses when `refreshScoutSchema` didn't return `source === "live"` (`planner.ts:230-237`); golden is never planned from; on success the stale-live-schema nuance matches ADR 0003:69 ("has succeeded this process"). Test: `service.test.ts:31-48` (`stub.calls === []` — zero Scout queries on failure).
- **Template deps validated before any `/v1/query`.** `planner.ts:276-288` → `tool-deps.ts:107-131` → `extractCypherSchemaRefs`/`missingTemplateDeps`; missing rel is rejected pre-flight. Test: `service.test.ts:51-77` (`rel:FOLLOWS`, `stub.calls === []`).
- **Raw Cypher stays behind the operator switch + full guard.** Planner emits `query_graph` only for Cypher-shaped questions with `rawEnabled` (`planner.ts:130-134`), else `guard_rejected` without any Scout call (`planner.ts:260-266`); the tool re-runs `guardRawCypher` with the live schema (`tools.ts:802-811`, `guard.ts:220-253`: length, semicolons, comments, writes, admin, CALL, START, LOAD CSV, unbounded varlen, LIMIT clamp, literal/params, profiling + MUTED denylists, schema-bound). Test: `service.test.ts:79-97`.
- **Planner/service never call `ScoutClient.query` directly.** Planner takes `Pick<ScoutClient, "schema">` (`planner.ts:48`); execution goes only through `createScoutTools`/`nexusTools` (`service.ts:110-123`), which enforce switch → budget → breaker/backoff → QPS bucket per call (`tools.ts:228-259`, `client.ts:97-117`). Budget exhaustion maps to the typed `budget_exhausted` outcome (test `service.test.ts:99-126`).
- **Breaker/limiter state is shared correctly** in the production wiring: module-global breaker (`circuit.ts:76-89`) and backoff (`client.ts:45-53`); one shared `ScoutClient` (and thus one token bucket) created in `process.ts:29` and threaded through. (The `opts.client ??` fallback at `service.ts:77` would silently create a per-request bucket — currently unreachable in production; covered by F-2's fix if the client is always injected.)
- **Typed outcomes; no 500s, no stacks.** All failure paths return 400/200 with `{outcome, reason}` (`http.ts:61-93`); only `Error.message` is ever serialized, never a stack; `mapToolError` maps BUDGET/SCOUT_BACKOFF/QUERY_REJECTED to typed outcomes (`service.ts:54-66`).
- **No Cypher injection from `question`/`asker`/`scope`.** Question-derived strings are length-capped and bound as `$params`; interpolated hops/limits go through `clampBound`; pubkys are Z32-validated (`planner.ts:79-90`, `tools.ts:7-11`); post URIs match a strict regex and are re-validated by `parsePostUri`.
- **No SSRF from request input.** Scout/Nexus origins are operator env only; `assertScoutUrl` pins the host on every request (`client.ts:40-43, 78-82`); the HTTP helper uses `redirect: "error"` (`http.ts:34`); request strings never become fetch URLs.
- **Allowlist additions carry no secrets.** `JEB_NLQ_PORT`/`JEB_NLQ_BIND` (`keys.ts:140-141`) are a port number and an address; the reason child's env surface is otherwise unchanged.
- **Intent byte-identity holds.** Kit `classifyIntent` (`nlq/intent.ts:101-118`) is statement-for-statement identical to the removed Jeb body; all 12 regex literals in `src/intent.ts` are byte-identical copies injected as `INTENT_REGEX_TABLES`; `toolsForIntent`/`FULL_TOOLS`/`SCOUT_TOOLS`/`NEXUS_READ` are single-sourced from the kit. Test: `nlq/intent.test.ts:44-89` cross-checks against Jeb's classifier on all fixtures, including self/bot/decline ordering.
- **MUTED posture preserved.** `profile_card` exposes only `muted_count` (`templates.ts:570-581`); raw MUTED visibility is aggregate-only (`guard.ts:119-144`).

## Not covered

- No test execution (read-only audit; suites require a live Postgres). All findings are from static reading of the diff and source.
- The upstream Scout gateway's own sanitization, and the Neo4j deployment behind it (trusted-dependency assumption per threat model; note a compromised schema response weakens the raw guard's schema-bound check — accepted trust).
- Nexus REST backend behavior; the publish process; the model/answer loop beyond comparison points; `ai` SDK internals.
- Whether the `JEB_DB_URL_REASON` PG role is actually least-privilege in any given deployment (the NLQ process inherits it, including DDL for migrations).
- Concurrency/perf testing of the token bucket and budget race (static review only — F-11).
- `docs/scout.md` latency/capacity claims and the Robots §13 plan references in ADR 0003 (out of code scope).

## Remediation 2026-09-04

| Finding | What changed | File | Test |
| --- | --- | --- | --- |
| F-1 | `net.isIP` bind; loopback is `127.0.0.1`/`::1` only; `JEB_NLQ_BIND_DANGEROUS=1` required for anything else with `log.warn` at startup and listen; `isLoopbackBind` called in `runNlqProcess`; `"localhost"` removed | `packages/bot-kit/src/nlq/env.ts`, `process.ts`, `http.ts`, `packages/bot-kit/src/security/keys.ts` | `refuses a non-loopback bind without JEB_NLQ_BIND_DANGEROUS`; `starts on a non-loopback bind and warns when JEB_NLQ_BIND_DANGEROUS=1` |
| F-2 | TTL schema cache started in `runNlqProcess`; planner reads `getActiveScoutSchema`/`getScoutSchemaSource`; breaker checked before planning; `schema()` uses the query token bucket; per-request client fallback removed | `process.ts`, `planner.ts`, `service.ts`, `scout/client.ts`, `scout/schema-cache.ts` | `fetches schema at most once within TTL across N requests`; `returns circuit_open with zero schema or query calls when the breaker is open` |
| F-3 | `main.ts` `--role nlq` passes `storeSwitchOn: () => switchOnSql(pool, "scout")`; service checks the switch before planning | `src/main.ts`, `src/db.ts`, `service.ts` | `returns switch_off with zero Scout calls when the scout switch row is on` |
| F-4 | Caller key (loopback remote address, or `JEB_NLQ_TOKEN` bearer as `nlq:token`) recorded as `mention_key`; `JEB_NLQ_DAILY_QUERIES` (default 200) counted over `mention_key LIKE 'nlq:%'`; `asker` is not a budget key | `http.ts`, `service.ts`, `scout/budget.ts`, `docs/nlq.md` | `applies the per-mention cap when mention_key is nlq-prefixed`; `applies JEB_NLQ_DAILY_QUERIES over mention_key LIKE nlq:%` |
| F-5 | Known codes map to static reasons; raw `e.message` / Scout `message` / response bodies logged server-side only | `service.ts`, `scout/client.ts`, `http.ts` (kit), `nlq/http.ts` | `does not reflect internal addresses from thrown errors` |
| F-6 | `tool.parameters.safeParse(call.args)` before `execute`; asker fields constrained to Z32 | `service.ts`, `scout/tools.ts` | `returns unsupported for out-of-range graph_scope.hops`; `returns unsupported for a malformed asker` |
| F-7 | IPv6 URL base `http://[::1]`; `JEB_NLQ_PORT` parsed as int 1–65535 with `invalid JEB_NLQ_PORT` | `nlq/env.ts`, `nlq/http.ts` | `serves /healthz 200 on an IPv6 loopback bind`; `parses JEB_NLQ_PORT as an int in 1-65535 with a named error` |
| F-8 | `asker` documented as unauthenticated; budgets use the F-4 caller key | `docs/nlq.md`, `service.ts` | (doc + F-4 tests; no budget keyed on `asker`) |
| F-9 | `cyphersForTool("profile_card")` lists all seven templates | `nlq/tool-deps.ts` | `lists all seven profile_card templates`; `covers every cypher each scout tool can emit` |
| F-10 | ALL-CAPS rel-token check documented as best-effort UX | `docs/nlq.md` | (doc-only) |
| F-11 | No change (pre-existing soft ceiling; noted) | — | — |
| F-12 | Explicit `requestTimeout` 30s / `headersTimeout` 10s / `maxConnections` 128; duplicate `"THE"` removed from `REL_NOISE` | `nlq/http.ts`, `planner.ts` | (constants + set membership) |
| F-13 | Doc: assert runs before key-dependent init; minimal-env section lists allowlisted vars only | `docs/nlq.md` | (doc-only) |
