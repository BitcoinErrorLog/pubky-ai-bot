# Pubchi Phase 0 + Bot Kit Brain — K1 remediation

**Source:** OpenCode Kimi external audit (`/tmp/pubchi-stage/kimi-K1.log`).
**Worktree:** `/Volumes/vibedrive/vibes-dev/pubky-ai-bot-w3`
**Branch:** `stage4/pubchi-w3-fixes`
**Base HEAD:** `61581d5`

**Verdict (Kimi):** FIX-FIRST — No key-material, signature, or asker/scope confusion flaws were found; the core verifier is sound. But every per-owner budget and rate limit is keyed by an attacker-chosen `bot` identity and is therefore voidable by any enrolled user (P1), and tenant resolution performs unauthenticated outbound work before signature verification with no timeout or pre-auth rate limit (P2).

**Remediation verdict:** all P1/P2 items FIXED. P3 items FIXED. P4 items FIXED except audience binding, which is WAIVED for Phase 0 (reason below). No P1/P2 waivers except the bot-allowlist *half* of the P1 recommendation.

## Findings

| Sev | Finding | Path | Disposition |
| --- | --- | --- | --- |
| P1 | Per-owner budgets keyed by attacker-chosen `bot` | `packages/pubchi/src/env.ts`, `budget.ts` | **FIXED** in `9f83a32`. Token bucket, daily ceiling, NLQ/Scout caps keyed `pubchi:${owner}`. Nonces stay `(bot, asker, nonce)`. Tests: two bindings B1,B2 under one owner share one bucket and one daily ceiling. |
| P1 | Operator bot allowlist (`JEB_KNOWN_BOTS`) | `tenant.ts` | **WAIVED.** Phase 0 enrollment is self-asserted by design (`pubky://U/pub/pubchi.app/bots/B.json`). Reciprocal verification is Phase 1. Owner-only keys close the budget-multiplication half of the finding. |
| P2 | Tenant resolve before signature verify | `http.ts`, `request.ts` | **FIXED** in `90fa466` + `2ab75e4`. Added `verifySignedRequestObjectV1` (schemas API additive; `verifyRequestObjectV1` keeps tenant-then-nonce order). HTTP runs parse + expiry + signature + nonce **before** `tenants.resolve`; owner/bot equality after. |
| P2 | No timeout on public `getJson` | `homeserver-read.ts` | **FIXED** in `2ab75e4`. 5 s timeout. |
| P2 | No pre-auth rate limit | `preauth.ts`, `http.ts`, `codes.ts` | **FIXED** in `2ab75e4`. Global `PUBCHI_PREAUTH_RPS` default 20/s burst 40; per-address 5/s burst 10; `429 RATE_LIMITED`. `X-Forwarded-For` honoured only when `PUBCHI_TRUST_PROXY=1`. |
| P2 | No negative cache for `UPSTREAM_UNAVAILABLE` | `tenant.ts` | **FIXED** in `2ab75e4`. 30 s per `(asker, bot)`. Tenant no longer logs (one pino line from `fail()`). |
| P3 | Brain egress redirect bypass | `packages/bot-kit/src/brain/openai-compatible.ts` | **FIXED** in `1b77621`. Custom `fetch` with `redirect: "error"`; 3xx treated as error. Moonshot/Ollama go through this adapter. Unit test: mocked 302 to another host → error; `Authorization` never sent off-host. No other brain path uses unguarded `fetch`. |
| P3 | Per-request token budgets not at model API | `feed.ts` | **FIXED** in `24b3504`. `maxOutputTokens` = tenant per-request output budget. Question estimated tokens (`ceil(len/4)`) over input budget → `SCHEMA_INVALID` before the brain. |
| P3 | UTC-day window uses session timezone | `budget.ts` | **FIXED** in `9f83a32`. Ledger day is `(now() AT TIME ZONE 'UTC')::date`. Tested with `SET TIME ZONE 'Asia/Tokyo'`. |
| P4 | Missing `body` → 503 | `canonical.ts`, `http.ts` | **FIXED** in `90fa466` + `2ab75e4`. Missing body coerced to `null` before hashing; absent `body` key → `400 SCHEMA_INVALID`; `TypeError`/`RangeError` from verify → `400 SCHEMA_INVALID`. |
| P4 | `pubchi_nonces` grows forever | `nonce.ts`, `108_pubchi.sql`, `process.ts` | **FIXED** in `94298ed`. Delete-on-insert every 32 consumes + 60 s sweeper. Migration comment added. |
| P4 | No audience binding in `RequestObjectV1` | `request.ts` | **WAIVED** for Phase 0. Single deployment; nonce DB per deployment; replay at a second operator only spends that operator's budget on the same public data. Queued for v2. Note under design-doc schema / request-object section (`eb26479`). Wire format unchanged. |
| P4 | Import-boundary test is shallow | `import-boundary.test.ts` | **FIXED** in `9856c1f`. Static import-graph walk from `process.ts` / `http.ts` / `index.ts` through the `src/` symlink tree. Dist variant dropped (src walk is the gate; `vitest.config.ts` excludes `packages/pubchi/**` and the compiled graph is the same files). |
| P4 | Budget check/charge TOCTOU | `budget.ts`, `http.ts` | **FIXED** in `9f83a32` + `2ab75e4`. `INSERT … ON CONFLICT … DO UPDATE … WHERE reserved + cap <= ceiling RETURNING`; refund on failure; `token_usage` on settle. Concurrent reserve tests for memory and Postgres. |
| — | Model-supplied `created_at` passed through | `feed.ts` | **FIXED** in `24b3504` (operator-found). Removed from model shape; server sets unix-seconds now; model value ignored. |

## Schemas package delta (App-vendored copy)

`verifyRequestObjectV1` semantics are unchanged (tenant checks still run before nonce consume). Additive only:

- `verifySignedRequestObjectV1` — parse, expiry, signature, body hash, nonce; no tenant.
- `bodySha256(undefined)` now hashes `null` instead of throwing `TypeError`.

## Doc inaccuracies (Kimi)

Corrected in `eb26479` (`docs/pubchi-phase0-service.md`, `.env.example`, `docs/pubchi-design.md`):

1. UTC-day wording now matches `(now() AT TIME ZONE 'UTC')::date`.
2. Per-request cap is a clamp; actual charges are 1 (`/v1/query`) and 2000 (`/v1/feed`).
3. One pino line per non-2xx — tenant double-log removed.
4. `--role pubchi` uses `PHASE0_BRAIN.model_id` (`kimi-k3`); `JEB_MODEL` is ignored for this role.
5. Staging vs production written once: Nexus/homeserver may be staging in dev; Scout default `https://nexus-scout.pubky.app` is production.
6. Normative canonical-JSON rule for `RequestObjectV1` signing added to the design doc.
7. `upstream_host` regex accepts `host:port`.

## Proof

```
npx vitest run src/pubchi packages/pubchi-schemas packages/bot-kit/src/brain
# 13 files, 99 tests passed
npm run build
# :8791 from dist, DATABASE_URL=…/jeb_pubchi_w3, JEB_MODEL_API_KEY unset, JEB_BRAIN=ollama
# signed request with missing body → 400 {"error":"SCHEMA_INVALID"}
# 60 rapid unsigned POSTs → {"400":9,"429":51}
# two bindings same owner: unit test in src/pubchi/budget.test.ts
```

`:8790` was not stopped. `:8791` was stopped after the live checks.

## Verified correct

Copied verbatim from the Kimi report:

- **Asker/scope confusion (threat 1):** Signature verifies against `request.asker`'s own key; tenant binding must satisfy `owner === asker` and `bot === request.bot` (`tenant.ts:46-60`, `request.ts:95-104`); `runQuery` ignores `body.asker`/`body.scope` and forces NLQ `asker`/`graph_scope.pubky` to the verified owner (`query.ts:157-168`; covered by `http.test.ts:109,132`). Query output is further constrained to the owner's own `pubky.app` URIs (`query.ts:50`, schemas `query.ts:49-63`). No path lets a request act for a different owner than the signer.
- **Canonicalisation:** the signed object contains only constrained ASCII/integer fields (z-base32 ids, lowercase hex, enums, unix ints) — no floats, no unicode, no free text — so JSON key ordering/unicode/number-format divergence cannot occur; verification runs over the *re-canonicalized parsed* object, neutralising duplicate keys, whitespace and escape tricks.
- **Ed25519 (threat 3):** OpenSSL RFC 8032 strict verification via SPKI prefix; pubky ids require a canonical z32 round-trip (`pubky.ts:7-15`); message bytes are the canonical unsigned object; verify is constant-time and fail-closed. Nonce insert is atomic (`INSERT … ON CONFLICT DO NOTHING RETURNING`), DB failure throws → 503 (**fails closed**), TTL 600 s + 60 s skew enforced in both directions.
- **CORS (threat 4):** exact-match allowlist only; no reflection, no `*` (a literal `*` in `PUBCHI_ALLOWED_ORIGINS` can never equal an `Origin` header, so it fails closed); no `Access-Control-Allow-Credentials`; `Vary: Origin`; `null` origin rejected; disallowed origins get a bare 204. CORS is never treated as auth — the handler runs regardless and the signature is the only auth. Tests at `http.test.ts:275-368` confirm.
- **Logging (threat 5):** all pubchi warn lines use constant codes plus a `cause` that is either a constant or run through `sanitizeCause` (redacts 64-hex, `postgres://`, `Bearer`, pubky URIs, 160-char cap). NLQ/Scout errors logged upstream are generic `ScoutToolError` messages; Cypher is never logged (only its sha256 in the `scout_queries` audit table); pino redaction covers all key-bearing env names. No request bodies, signatures, or questions appear at level 40.
- **Brain egress parsing (threat 6):** hostname extracted via `new URL`, lowercased, brackets stripped; userinfo tricks resolve to the real connection host; `0.0.0.0`, IPv4-mapped IPv6, non-`::1` IPv6 loopback forms, trailing-dot and lookalike hosts all fail closed; decimal/octal IPs normalise to `127.0.0.1` *before* the check; enforced twice (`config.ts` `assertConfigBrainEgress` and adapter construction); `JEB_BRAIN_EGRESS_DANGEROUS=1` required otherwise; no error path includes the API key (`BrainEgressError` carries only the host; feed maps all brain errors to `BRAIN_UNAVAILABLE`).
- **Keyless boundary (threat 8):** `assertNoKeyMaterial()` at both `main.ts:196` and `process.ts:60`; `requireSecret:false` yields a dummy zero key; `import-boundary.test.ts` exists (see P4 for its shallowness); my transitive walk confirms no publisher/session code is reachable today.
- **Feed safety:** model output passes `parseFeedProposalV1` + `PubkyAppFeed.fromJson`; likes/followers-reach refused both pre- and post-model; `installed_user_feed_id` forced `null`; no tools in the feed brain call; `maxSteps:1`; abort at the 30 s wall-clock budget; no fallback brain (`create.ts:20-24`).
- **Gateway hygiene:** loopback default bind with `PUBCHI_BIND_DANGEROUS` gate; 64 KB body cap enforced during read; headers/request timeouts; `maxConnections` 128; whitelisted error codes only in `{error}` responses.

## K1b re-audit (SHIP)

**Source:** OpenCode Kimi external re-audit (`/tmp/pubchi-stage/kimi-K1b.log`).
**Worktree:** `/Volumes/vibedrive/vibes-dev/pubky-ai-bot-w3`
**Branch:** `stage4/pubchi-w3-fixes`
**Base HEAD:** `d777c56`

**Verdict (Kimi):** SHIP — No P0/P1 is introduced or still present. The K1 P1 budget-key flaw is verifiably closed (owner-keyed everywhere), the P1 allowlist waiver is acceptable under owner-keyed budgets, and every other K1 item is fixed or acceptably waived. New findings are P3/P4 only and do not trigger the do-not-ship rule.

### Per-finding table (verbatim from K1b)

| K1 finding | Verdict | Evidence |
|---|---|---|
| P1 budgets keyed by attacker-chosen `bot` | **FIXED-VERIFIED** | `env.ts:87-93` (`ownerBudgetKey` = `pubchi:${owner}`; `scoutMentionKey` ignores bot); `budget.ts:43,84,97,139` (bucket + reserve + check all owner-keyed); `query.ts:158`; grep confirms no remaining bot-keyed budget path (only nonces stay `(bot,asker,nonce)`, intended). Test: two bindings B1/B2 same owner share bucket+ceiling (`budget.test.ts:11-27`). |
| P1 atomic reserve / TOCTOU / refund | **FIXED-VERIFIED** | `budget.ts:99-109` single-statement `INSERT…ON CONFLICT DO UPDATE … WHERE reserved + EXCLUDED.reserved <= $3 RETURNING` — no TOCTOU (row lock, atomic). Refund on throw (`http.ts:284`) and on failed outcome (`http.ts:288`); settle only on 200 (`http.ts:295`). Concurrency tests for memory + Postgres (`budget.test.ts:29-36,104-132`). |
| P1 operator bot allowlist | **WAIVER-ACCEPTED** | Multiplication vector is closed: bucket, daily ceiling, NLQ/Scout caps are all owner-only now, so N self-asserted bots yield no extra budget. Bot-keyed remainders (nonce rows, tenant cache) are post-signature, rate-limited, and swept. Phase 0 enrollment is self-asserted by design; reciprocal verification is Phase 1. |
| P2 verification order | **FIXED-VERIFIED** | `http.ts:219-248`: parse → `verifySignedRequestObjectV1` (expiry, signature, body hash, nonce consume) → *then* `tenants.resolve` → asker/bot equality (`:247-248`). Test proves resolve is not called on bad signature (`http.test.ts:417-437`). No unauthenticated outbound remains: `/healthz` and OPTIONS do no I/O; preauth and nonce store are local/DB. |
| P2 homeserver timeout | **FIXED-VERIFIED** | `homeserver-read.ts:13,25-39,50` (5 s `withTimeout` inside `createPublicHomeserverReader`), `wrapReaderTimeout:60-66`; used by `process.ts:78`. |
| P2 pre-auth rate limit | **FIXED-VERIFIED** | `preauth.ts` (global 20 rps/40 + per-addr 5 rps/10), wired pre-`readBody` for all non-`/healthz` requests (`http.ts:327-338`); 429 `{error:"RATE_LIMITED"}` (`codes.ts:27`). XFF only under `PUBCHI_TRUST_PROXY=1` (`env.ts:117-134`). Bypass attempts: spoofed XFF w/o trust → ignored; spoofed/rotated XFF or IPv6 rotation *with* trust → only evades the per-IP bucket, the **global bucket still caps**; missing `remoteAddress` → shared `"unknown"` bucket (fail-closed). Live test: rapid unsigned POSTs → mix of 400/429 (`http.test.ts:476-494`). |
| P2 negative cache | **FIXED-VERIFIED** | `tenant.ts:14,86-89,101-110,117-127`: 30 s for `UPSTREAM_UNAVAILABLE`, keyed `(asker,bot)`. **No cross-asker poisoning:** resolve happens only after signature verification, so asker A can only create cache entries for A's own `(A,bot)` pairs — a malicious asker can only negatively-cache themselves. Test `tenant.test.ts:55-74`. |
| P3 brain redirect / Authorization off-host | **FIXED-VERIFIED** | `openai-compatible.ts:16-34`: guarded fetch re-asserts `isAllowedBrainHost` on the *actual request URL per call*, forces `redirect:"error"`, and throws on any 3xx — the key cannot reach a non-allowlisted host by any path. Moonshot and Ollama both wrap this adapter (`moonshot.ts:12`, `ollama.ts:16`); a test greps all other brain files for `fetch(`/`generateText` (`brain.test.ts:285-291`) and a mocked-302 test proves no off-host request (`:241-270`). |
| P3 maxOutputTokens + input budget | **FIXED-VERIFIED** | `feed.ts:73` passes `maxOutputTokens = per_request_output_tokens` (plumbed to `maxTokens` at `openai-compatible.ts:72`); `feed.ts:56-58` rejects `ceil(len/4) > per_request_input_tokens` with SCHEMA_INVALID pre-brain (test: brain not called, `feed.test.ts:27-37`). `/v1/query` needs no clamp: NLQ contains no brain/`generateText` call (grep-verified), so no model tokens are spent there. |
| P3 UTC-day window | **FIXED-VERIFIED** | `budget.ts:76` `(now() AT TIME ZONE 'UTC')::date` used in check/reserve/refund; Tokyo-timezone test (`budget.test.ts:58-102`). See N4 for a residual in *Scout/NLQ* ceilings. |
| P4 missing body → 503 | **PARTIAL** | Missing `body` → 400 SCHEMA_INVALID (`http.ts:217`); `TypeError`/`RangeError` from verify → 400 (`http.ts:190-192,231-233`); my live probe: signed request with 40 000-deep **body** → 400 ✓. **But** a 4 000-deep **request object** throws `RangeError` out of `parseRequestObjectV1` (`http.ts:219`, *outside* the guard) → server catch → **503**. Verified live against `dist`. K1 explicitly named this sub-case (`scanForbidden` recursion, `forbidden.ts:103-119` has no depth cap). See N1. |
| P4 `pubchi_nonces` growth | **FIXED-VERIFIED** | Delete-on-insert every 32 (`nonce.ts:4,27-31`) + 60 s sweeper (`process.ts:27,112-115`, unref'd, cleared on shutdown); migration comment added; tests `nonce.test.ts`. See N3 for a sweeper-robustness nit. |
| P4 audience binding | **WAIVER-ACCEPTED** | Single Phase 0 deployment; replay at a second operator spends only that operator's (owner-keyed) budget on the asker's own public data; wire format unchanged; v2 binding queued and now written into the design doc (`docs/pubchi-design.md:787-791`). Acceptable for v1. |
| P4 import-boundary test shallow | **FIXED-VERIFIED** | `import-boundary.test.ts:25-58`: real transitive walk from `process.ts`/`http.ts`/`index.ts` through `realpathSync` (symlink-safe), asserts entries exist and `reached.size > 10` (fails closed), `FORBIDDEN_PATH` now covers `bot-kit/publish/` (incl. `upload.ts`, the K1 gap), `tags/`, and `homeserver(?!-read)`, plus content greps for session/PUT APIs. Dist variant dropped — src walk is the gate; reasonable. Nit: dynamic `import(...)` isn't matched by the regex (N5); none exist in the tree today. |
| Model-supplied `created_at` (operator-found) | **FIXED-VERIFIED** | `feed.ts:92-93` strips model `created_at` and sets server `now`; system prompt updated (`:12`); test `feed.test.ts:8-23`. |

### New findings (N1–N5)

| Id | Sev | Finding | Disposition |
| --- | --- | --- | --- |
| N1 | P4 | Deeply-nested `request` object still yields 503, not 400 | **FIXED** in `6e7ffbb`. `parseRequestObjectV1` runs inside the TypeError/RangeError → 400 guard. `scanForbidden` / `canonicalize` cap nesting at 64 and return/throw a structured too-deep result (`SCHEMA_INVALID` / `RangeError("too deep")`) instead of recursing. Tests: 4000-deep request → 400 `SCHEMA_INVALID`; 4000-deep body → 400 `SCHEMA_INVALID`. |
| N2 | P3 | Owner-keyed `pubchi:${owner}` falls into the all-time Scout per-mention cap | **FIXED** in `31d929b`. `isPersistentCallerKey` + `persistent` option; per-mention branch applies only to unique-per-mention keys. Persistent `nlq:` / `pubchi:` keys use `checkNlqDailyBudget` only. Jeb mention path is unchanged (still all-time cap). Tests: `pubchi:` + 13 ok rows not exhausted; plain mention + 12 ok rows still is; pubchi daily ceiling still trips. |
| N3 | P4 | Nonce sweeper interval: unhandled rejection on DB error | **FIXED** in `6e7ffbb`. `sweepExpiredNoncesSafe` attaches `.catch` and logs at debug. Test: pool whose `query` rejects does not throw. |
| N4 | P4 | NLQ/Scout daily ceilings used session-timezone `date_trunc('day', now())` | **FIXED** in `f237dd9`. Same `(now() AT TIME ZONE 'UTC')::date` start-of-day as `packages/pubchi/src/budget.ts:76`. Tokyo-timezone test on `checkNlqDailyBudget`. **Jeb's own budget semantics are unchanged apart from the UTC day boundary** (all-time per-mention cap, daily/raw ceilings, and NLQ daily ceiling still apply; only the calendar-day cutover is UTC). |
| N5a | P4 | Import-boundary regex missed dynamic `import(...)` | **FIXED** in `5386459`. Walk matches `import("...")` / `import('...')` as well as static `from` / `import` specifiers. |
| N5b | P4 | Unbounded in-memory maps (preauth IPs, tenant cache, token bucket) | **ACCEPTED** for Phase 0. Growth is rate-capped by the global preauth bucket (~20 inserts/s worst case with rotated XFF/IPv6 or fresh signed pairs) and resets on process restart. Noted under service ops notes. |

### Schemas package delta (App-vendored copy)

The `pubchi-schemas` K1b change (`MAX_JSON_DEPTH = 64` on `scanForbidden` / `canonicalize`) is **additive/behavioural only**. Deep inputs were already rejected as errors (`RangeError` → 503/400 depending on the caller). The App-vendored copy at the previous pin remains wire-compatible for every representable (non-pathological) payload; re-vendor at the next sync so the App matches the depth cap.

### Proof

```
npx vitest run src/pubchi packages/pubchi-schemas packages/bot-kit/src/brain packages/bot-kit/src/scout
# 17 files, 153 passed | 3 skipped
npm run build
# :8791 from dist, DATABASE_URL=…/jeb_pubchi_w3, JEB_MODEL_API_KEY unset, JEB_BRAIN=ollama
# unsigned POST 4000-deep request object → 400 {"error":"SCHEMA_INVALID"}
```

`:8790` was not stopped. `:8791` was stopped after the live check.
