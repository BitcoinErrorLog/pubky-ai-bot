# Kimi External Re-Audit A6rr — Final pass on round-2 remediation (N-1..N-6, F-6)

**Range:** `3b110c9` → `HEAD` (`7c4288e`; code in `d71213a`, docs in `ba8e907`/`7c4288e`). **Base:** `docs/kimi-reaudit-a6r-2026-09-05.md` ("Remediation (round 2)" mapping). **Method:** read-only; `git diff 3b110c9 HEAD -- <path>` per changed file; full reads of `publisher.ts`, `publish-store.ts`, `publish.ts`, `weekly/store.ts`, `weekly/publish-article.ts`, `weekly/loop.ts`, `weekly/cli.ts`, `weekly/run.ts`, `drafts/evidence-uri.ts`, `knowledge/manifest.ts`, `tags/denylist.ts`, `tags/policy.ts`, `db.ts`, `reason.ts`, `config.ts`; adversarial trace of the five probe questions.

**Tests executed here (75 passed, 0 failed), `DATABASE_URL=postgres://localhost:5432/jeb_merge_test`:**
- DB-backed (64): `src/publish.test.ts` (52), `src/weekly/idempotency.test.ts` (6), `src/weekly/loop.test.ts` (2), `src/weekly/cli.test.ts` (4).
- Pure (11): `packages/bot-kit/src/tags/policy.test.ts` (7), `src/drafts/evidence-uri.test.ts` (4).

## Verdict: SHIP

All six round-2 findings are FIXED and F-6 is upgraded from PARTIAL to FIXED. The N-1 race is closed at the correct layer (origin row with `mention_key` commits before the claimable publish row), the retry paths all have terminal ceilings, `--force` cannot produce a duplicate article in any traced interleaving, and the kill switch is honoured at both the CLI and the signing boundary. Two Low/Info hardening gaps (NN-1 one-line SQL guard, NN-2 missing test pin) are follow-ups, not blockers.

## Per-finding status

| # | Status | Evidence (file:line @ 7c4288e) | Pinning test (ran here) |
|---|---|---|---|
| N-1 | **FIXED** | `mentionKey` computed before claim from the same `content`/`kind` later enqueued — `src/weekly/publish-article.ts:47-49`; `claimWeeklySlot` INSERT carries `mention_key` — `src/weekly/store.ts:172-186`; identical hash: `standaloneMentionKey` is the same function with the same inputs (`attachments ?? []`, `collectionId ?? null` seed defaults) at claim, enqueue (`publisher.ts:215-217`) and the signing re-check (`publisher.ts:567-572`). Origin-missing is now `markPublishRetry(row.id, …, row.attempts)` — `publisher.ts:585-589`; ceiling: claim requires `attempts < maxPublishAttempts` (=5, `config.ts:239`) and `failExhaustedPublishes` runs every tick (`publisher.ts:808`), so a forged row ends `failed` after 5 claims (backoff ≤30 s each). | `publish.test.ts` "retries approved_by=weekly without a matching weekly_posts.mention_key row", "does not permanently fail when weekly enqueue lands after the publish row" (flipped order: 0 PUTs → retry → origin row → 1 PUT), "publishes … when weekly_posts.mention_key matches" ✓; `idempotency.test.ts` "writes mention_key at claim time" ✓ |
| N-2 | **FIXED** | `post_uri IS NULL` added to reaper `store.ts:327` and counter `:336`; `markWeeklyPublished` (`store.ts:342-348`) wired in both hook paths (`src/publish.ts:81-83`, `:204`) with `mentionKey` added to hook info (`publisher.ts:738`). | `idempotency.test.ts` "does not reap a queued week that already has a post_uri", "marks a weekly row published by mention_key and lists last skipped" ✓; `publish.test.ts` weekly-match test asserts `weekly_posts.status='published'` ✓ |
| N-3 | **FIXED** | Exactly one compose retry (2 s default, injectable) — `loop.ts:13,70-101`; the retried call is not itself retried, second throw → `latchSkippedSlot` (`:20-31`). Health `lastSkippedWeekly` — `store.ts:351-364` → `reason.ts:83-84`. `--force`: refuses `--dry-run` (`cli.ts:43`), requires week key (`:52`), reclaims only `status='skipped'` (`store.ts:366-381`). Kill switch honoured pre-reclaim (env `:57-59`, DB `:62-65`) and again at signing (`publisher.ts:613-616,632-634`). No duplicate: published weeks are `published`/`queued`+`post_uri` (reclaim refuses); legacy `skipped`+`post_uri` rows dedupe at `insertPublishRequest` (original row `published` ∈ conflict index) and the deterministic post id backstops even a fresh insert. | `loop.test.ts` "retries once then latches…" (`toHaveBeenCalledTimes(2)`), "does not latch when the first compose throw succeeds on retry" ✓; `cli.test.ts` "refuses --force with --dry-run and when the slot is not skipped", "reclaims a skipped slot…" ✓ |
| N-4 | **FIXED** | `httpsHostsFromSources` skips `enabled === false`, URL-parses `location`/`cite_base`, admits only `https:`, adds `u.hostname.toLowerCase()` (hostname excludes port/userinfo) — `evidence-uri.ts:24-40`; malformed URLs skipped per-entry (try/catch); missing manifest → `[]` (fail-closed) `:50-70`; merged into `evidenceHttpsHosts` `:74-82`; all five generator call sites pick it up via the cached default (verified by grep — no call site passes `extraHosts`). | `evidence-uri.test.ts` "merges enabled manifest location and cite_base hosts" (synonym.to/bitkit.to allowed, disabled evil.example absent) ✓ |
| N-5 | **FIXED** | Display-name equality requires `z32Token \|\| (n.length >= 8 && p.length >= 8)` — `denylist.ts:60-66`; static `TAG_PERSON_DENYLIST` (`:58`), `@handle` branch (`:70`) and ≥8-floored prefix branches (`:67-68`) unchanged. | `policy.test.ts`: "alice"/"pubky"/"satoshi" equality now false, "paolo-ardoino" true, "@alice" true (handle branch), z32 exact + 8-char fragment true ✓ |
| N-6 | **FIXED** | `recordOpenTagDenial` skips the outer increment for `secret-scrubber` — `policy.ts:60-65`; both publisher call sites converted (`publisher.ts:367`, `:459`); no other `incrementSecurityEvent(denied)` callers remain. | `policy.test.ts` "does not increment secret-scrubber twice at the caller" ✓ |
| F-6 | **FIXED** (was PARTIAL) | Unanswered auto tags: deadline check 10 min from `created_at` → terminal fail (`publisher.ts:433-441`, `ARTIFACT_TAG_UNANSWERED_DEADLINE_MS=600_000` `:32`); else `markArtifactTagDeferUnanswered` undoes the claim increment (`GREATEST(attempts-1,0)`) and defers 30 s (`publish-store.ts:368-379`); `created_at` returned at claim (`publish-store.ts:334,345`); `status <> 'revoked'` guards intact. `created_at` has **no application write path** (all `artifact_tags` UPDATEs inspected; `insertArtifactTag` is ON CONFLICT DO NOTHING) — only direct SQL could rewrite it (out of threat model). Ceiling is enforced at process time immediately after claim (publisher.ts:435-441), not in claim SQL — equivalent, since a claimed past-deadline row is failed on that same pass. | `publish.test.ts` unanswered test now asserts `attempts=0` + `retry`; "still tags a reply published 60s after unanswered deferrals" (3 deferrals → reply → 1 PUT) ✓. **Deadline→failed branch itself is unpinned — NN-2.** |

## Probe answers (required round-2 review)

1. **N-1 hash identity & retry ceiling.** Identical: claim-time (`publish-article.ts:48`), enqueue-internal (`publisher.ts:217`) and signing re-check (`publisher.ts:567-572`) all call `standaloneMentionKey` on the same content string with kind `"long"` and default `attachments=[]`/`collectionId=null` — same seed literal, same key order, same sha256. Ceiling: yes — a truly forged `approved_by='weekly'` row accumulates one `attempts` per claim and is terminally `failed` by `failExhaustedPublishes` once `attempts >= 5`; it cannot be retried forever. The legitimate flipped-order case succeeds on attempt 2 (500 ms backoff ≫ the ms-scale `finishWeeklySlot` commit).
2. **N-3 `--force`.** Cannot publish the same week twice: reclaim requires `status='skipped'`; the only `skipped` rows with a live article are legacy round-1-reaper flips, and those dedupe at `insertPublishRequest` (ON CONFLICT on `mention_key` includes `published`) with the deterministic post id as second backstop — worst case is wasted compose tokens (NN-1). Honours the kill switch at CLI (env + DB switch checked before reclaim) and at signing (`weeklyBlocked` throws → retry, never PUTs while on). Compose retry is bounded to exactly one (test-pinned `toHaveBeenCalledTimes(2)`); a retry that reaches `enqueueWeeklyArticle` after a partial first attempt dedups via `claimWeeklySlot=false` and cannot double-enqueue.
3. **F-6 ceiling.** Not at claim time — enforced at process time one statement after claim (`publisher.ts:435-441`), which is equivalent for a single publisher. `created_at` cannot be rewritten by any code path (verified all six `artifact_tags` writers); a far-future `created_at` would defer forever but requires direct DB write (already full compromise). Clock skew between DB (`now()`) and publisher (`Date.now()`) only stretches the 10 min by the skew. Deferred rows keep `attempts` flat, so `failExhaustedArtifactTags` can never terminate them — the 10-min deadline is the sole terminal bound, and it works as traced.
4. **N-4 manifest hosts.** Disabled entries cannot add a host (`enabled === false` skip; `parseManifest` coerces the field to boolean — `manifest.ts:54`). Malformed `location`/`cite_base` URLs are skipped individually; a structurally invalid source (missing `location`) throws `parseManifest` and drops **all** manifest hosts — fail-closed (NN-4 note). Hosts are normalised: WHATWG `hostname` (lowercase, no port, no userinfo, punycode) plus explicit `trim().toLowerCase()` at merge (`evidence-uri.ts:76-79`). Note `https://synonym.to:8443/…` passes — host-based allowlist semantics, same as the pre-existing static set.
5. **N-2 mention_key collision.** A non-weekly standalone can match a weekly `mention_key` only with byte-identical content+kind (content-seed sha256) — i.e. the same article; `insertPublishRequest` dedupe additionally prevents two live rows sharing the key. The UPDATE has no status guard, which is intentional self-heal (`skipped`→`published` when a late publish lands) and is also what repairs the latch-with-queued-row overlap: the attempt-1 publish row still publishes (origin row kept its `mention_key` through the latch — `finishWeeklySlot` COALESCEs, `store.ts:199-205`) and flips the week to `published`, after which `--force` correctly refuses.

## New findings

### NN-1 — Low — `reclaimSkippedWeeklySlot` is missing the `post_uri IS NULL` guard every other skipped/queued consumer has
- **Where:** `src/weekly/store.ts:366-381` (`DELETE … WHERE status='skipped'`, no `post_uri` predicate). Docs (`docs/weekly.md:24`) claim "unpublished only".
- **Impact:** production rows flipped to `skipped` by the round-1 reaper *despite having `post_uri`* (every week published before this deploy — the original N-2 bug) are reclaimable by `weekly run --force`. No duplicate article results (publish-layer `mention_key` dedupe + deterministic post id), but the run spends the full compose token budget and re-marks feedback included (`publish-article.ts:95-97`, not gated on `inserted`) before discovering the dedupe.
- **Fix:** add `AND post_uri IS NULL` to the DELETE, matching `reapStaleWeeklyQueued` (`:327`) and `lastSkippedWeeklyBySeries` (`:357`).

### NN-2 — Low — F-6 terminal deadline branch has no test pin
- **Where:** `packages/bot-kit/src/publish/publisher.ts:436-440` (`markArtifactTagFailed("…timed out")`). Tests pin the deferral (`attempts=0`, 30 s retry) and the 60 s late-answer recovery, but nothing drives a row past the 10-minute `created_at` ceiling.
- **Impact:** the deadline is the *only* terminal bound for deferred rows (their `attempts` never reach `TAG_MAX_ATTEMPTS`); a regression here (e.g. inverted comparison) reintroduces the infinite-deferral/wedge silently.
- **Fix:** one test: `UPDATE artifact_tags SET created_at = now() - interval '11 minutes'`, claim, `applyArtifactTagOne`, assert `status='failed'`, 0 PUTs.

### NN-3 — Info — `markWeeklyPublished` does not set `post_uri`
- **Where:** `src/weekly/store.ts:342-348`; both call sites have `info.uri` in scope (`src/publish.ts:81-83`, `:189-205`).
- **Impact:** rows healed through the claim→finish gap or the reap/publish overlap read `status='published'` with `post_uri NULL`; cosmetic only (reaper/`lastSkippedWeekly` predicates unaffected; real URI recoverable via `publish_requests`).
- **Fix:** `markWeeklyPublished(db, mentionKey, postUri)` → `SET status='published', post_uri = COALESCE($2, post_uri)`.

### NN-4 — Info — manifest/evidence-uri parsing notes
- **Where:** `packages/bot-kit/src/knowledge/manifest.ts:54` + `src/drafts/evidence-uri.ts:28` (quoted YAML `enabled: "false"` coerces to enabled → host added); `evidence-uri.ts:56-69` (one structurally malformed source throws `parseManifest` → *all* manifest hosts dropped, fail-closed); `ARTIFACT_TAG_UNANSWERED_BACKOFF_MS` duplicated in `publish-store.ts:369` and `publisher.ts:30` (drift risk; the store layer uses its own copy).
- **Impact:** operator-config foot-guns only; the security-relevant direction (unknown/disabled host admitted) requires a misquoted boolean in a repo-committed file. All-or-nothing parse failure is fail-closed (static set only) but silently drops legitimate hosts.
- **Fix:** coerce `enabled` with `=== false || === "false"` or validate type in `parseManifest`; per-source try/catch in `httpsHostsFromSources` callers (or pre-validated manifest); import the backoff constant from one module.

## Verified properties

- **N-1 closed at both layers:** origin row (with content-identical `mention_key`) commits *before* the claimable publish row exists (`publish-article.ts:49` before `:66`); even a hypothetical residual race is retryable and attempt-capped (5 claims → terminal `failed`), and the enqueue-throw path still deletes its un-finished origin row (`publish-article.ts:72-78`) so a later tick re-claims cleanly.
- **No duplicate-article trace exists** across `--force`, latch, reaper, and retry interleavings: reclaim requires `skipped`; `insertPublishRequest` dedupes on `mention_key`; the deterministic post id makes even a fresh insert an in-place overwrite of the same homeserver path.
- **Kill switch coverage is complete:** weekly CLI (env + DB), weekly loop tick (`loop.ts:24-26`), and publisher signing (`weeklyBlocked` ×2) — a `--force`-enqueued row cannot PUT while the switch is on.
- **F-6 invariants:** deferral preserves `attempts` (verified `attempts=0` after three claim/defer cycles), honours `revoked`, aligns with the 30 s PUT backoff, and a 60 s-late reply still gets its tag (test-pinned); non-auto (`op`) approver flow unchanged.
- **A6r verified properties intact:** F-10 forged-origin still fails closed (retry→exhaust→failed, never PUTs); `expectedKey` content-seed re-check unchanged; denylist boundary semantics otherwise unchanged (z32 fragment, static person list, `@handle` all still denied; test-pinned); `status <> 'published'`/`revoked` guards untouched.
- All 75 executed tests pass; diff is confined to the remediation surface plus docs (`docs/limits.md` 2×-cap wording and `docs/weekly.md` operator recovery now match the code).

## Not covered

- **Full test-suite run** — only the six remediation-relevant files were executed (75 tests); `tsc`, ingest/scout/nlq/eval suites not re-run.
- **Live race reproduction** — the flipped-order test serialises the interleaving; no concurrent publisher/loop race was triggered. Analysis assumes a single publisher (as in A5r/A6/A6r).
- **Production data migration** — historical weeks mislabeled `skipped` by the round-1 reaper stay `skipped` (no backfill in this diff); they are excluded from `lastSkippedWeekly` by the `post_uri IS NULL` filter, but see NN-1 for their `--force` reachability.
- **`ai-sdk`/Nexus/homeserver internals** (library trust boundaries, as in prior audits).
- **`JEB_SOURCES_YAML` path override / module-level host cache invalidation** — first-read-wins per process; sources.yaml edits require restart (matches config-load semantics).

KIMI_REAUDIT_A6RR_COMPLETE

## Remediation (round 3)

Code: `9ab4c3b`. Mapping:

| # | Change | Commit |
|---|---|---|
| NN-1 | `reclaimSkippedWeeklySlot` DELETE requires `post_uri IS NULL`. A skipped row with `post_uri` is not reclaimed. | `9ab4c3b` |
| NN-2 | `publish.test.ts` pins the F-6 deadline: `created_at = now() - 11 minutes` → `status='failed'`, 0 PUTs. | `9ab4c3b` |
| NN-3 | `markWeeklyPublished(db, mentionKey, postUri)` sets `post_uri = COALESCE($2, post_uri)`. Both `src/publish.ts` hooks pass `info.uri`. | `9ab4c3b` |
| NN-4 | `parseEnabled` treats `"false"` as disabled and rejects non-boolean types. `httpsHostsFromSources` wraps each source so one malformed entry drops only itself. `ARTIFACT_TAG_UNANSWERED_BACKOFF_MS` lives in `publish-store.ts`; publisher re-exports it. | `9ab4c3b` |
