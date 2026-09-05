# Kimi External Audit A6 — Autonomous publishing, quoting, open tags, collections

**Range:** `90d35c4` (deployed) → `f21c1b5` (candidate). **Method:** read-only static audit — per-file `git diff 90d35c4 f21c1b5 -- <path>` for every in-scope file, full reads of `src/weekly/**`, migrations 103/104/107, kit publish/tags/collections modules, wiring in `src/publish.ts`, `src/reason.ts`, `src/db.ts`, `src/health.ts`, plus context docs. Prior audits A1/A5/A5r read; closed findings (A1 F-1; A5 F-1..F-5; A5r F-N1..F-N5) verified unregressed by inspection of the current code, not reopened. Pure (non-DB) tests executed: `policy.test.ts`, `rules.test.ts`, `classify.test.ts`, `content.test.ts`, `schedule.test.ts`, `render.test.ts`, `learn.test.ts`, `tag-collect.test.ts`, `gather.test.ts`, `classify-mentions.test.ts` — **59 passed, 0 failed**. DB-backed suites not run (no writable Postgres here).

## Verdict: FIX-FIRST

No remote path was found that puts attacker-chosen links, images, mentions, or instructions into Jeb's articles or tags — the quote sanitizer, bullet link allowlist, and bullet/link validation are genuinely enforced at the right layers, and both sentinels (`weekly`, `jeb-answered`) are re-checked at the signing boundary against server-side state. Two Medium issues need small fixes before ship: (F-1) the post-publish collections hook runs *after* `markPublishDone` with no try/catch and an unguarded `markPublishRetry`, so a hook failure recycles a live row and — once any collection crosses the 100-item cap — poisons every later standalone publish and blocks publisher startup; (F-2) a weekly article that fails composition (e.g. outbound-gate block) leaves no `weekly_posts` row, so the scheduler recomputes the entire article — all model calls included — every 60 seconds for the whole fire day.

---

## Findings

### F-1 — Medium — Post-publish collections hook can fail an already-published row; >100-item collection self-DoSes standalone publishing and publisher boot

- **Where:** `packages/bot-kit/src/publish/publisher.ts:661-676` (`markPublishDone` at :661, then unguarded `await hooks.onStandalonePublished(...)` at :668-675); tick catch at `publisher.ts:753-755`; unguarded `markPublishRetry` (`packages/bot-kit/src/publish/publish-store.ts:241-248`, `WHERE id = $1`, no status guard); `src/collections-maintain.ts:105-120` (`appendUriToCollection` writes items, *then* enqueues); item cap throw in `packages/bot-kit/src/publish/post.ts:85-92` (cap = 100, `:63-67`); startup reconcile `src/publish.ts:170-176` → `src/collections-maintain.ts:43-68`.
- **What:** `onStandalonePublished` (`recordPublishedStandalone` + `appendPublishedToCollections`) runs after the PUT and after `markPublishDone`, with no try/catch. Any throw (transient DB error, or deterministically once a collection reaches 101 items: `replaceCollectionItems` persists the 101 rows, then `buildCollectionPost` → `assertCollectionItems` throws) propagates out of `publishOne`; the tick calls `markPublishRetry`, which flips the row from `published` back to `retry`. The row is re-claimed and re-PUT (same deterministic `replace_post_id`, so no duplicate post — but up to `maxPublishAttempts` wasted signed PUTs) until `failExhaustedPublishes` marks it `failed` — a live post whose row says failed. Worse: once `collection_items` for any rule exceeds the cap (Jeb's Blog collects *every* long post — drafts + 2 weekly), **every** subsequent standalone publish ends `failed`, and at the next restart `reconcileCollections` throws out of `onStart`, so `runPublish` rejects before opening the transport — the publisher process cannot boot.
- **Impact:** state-integrity corruption (live post / `failed` row), retry amplification, and a slow-burn certain publisher outage at the 101st long post.
- **Fix:** (a) wrap the `hooks.onStandalonePublished` call in try/catch + warn — post-publish bookkeeping must never fail the row; (b) defense in depth: add `AND status <> 'published'` to `markPublishRetry`; (c) bound membership at write time: cap at `collectionItemLimit()` inside `appendItemIdempotent` or `replaceCollectionItems` (keep oldest or newest N, operator's choice) so the enqueue can never throw on size; (d) wrap each rule's `enqueueCollectionUpsert` in `reconcileCollections` in try/catch so one bad rule cannot abort startup.

### F-2 — Medium — Weekly compose failure is not latched: scheduler recomputes the full article (all model spend) every 60 s for the entire fire day

- **Where:** `src/weekly/loop.ts:39-59` (fires `runWeeklySeries` whenever `getWeeklyPost` returns null; failures only `log.warn`); `src/weekly/types.ts:35` (`WEEKLY_SCHEDULER_INTERVAL_MS = 60_000`); `src/weekly/publish-article.ts:21-28` (`prepareArticleBytes` throws on outbound-gate hit *before* `claimWeeklySlot`); raw post bodies into the summariser prompt at `src/weekly/updates-article.ts:41,46` (no secret redaction upstream of the model).
- **What:** `weekly_posts` is only written on success (or the explicit zero-items skip). If composition deterministically fails — the realistic trigger is the outbound gate: an attacker plants a secret-shaped string (64-hex, mnemonic, `sk-…`) in a post that names a tracked project; it flows unredacted through `sourceLine` into the summariser and, when the model quotes it, `scanOutboundText` rejects the article — then no slot row exists, and the next tick (60 s later) re-runs the *entire* pipeline: mention classification (uncapped, see F-3) plus every project section up to `JEB_WEEKLY_TOKEN_CAP` (400 k) — again and again until the weekday ends (~15 h ≈ 900 recomputes) or an operator flips the switch.
- **Impact:** attacker-triggerable suppression of that week's article plus large repeated token spend, bounded only by the per-run cap multiplied by ~900 runs.
- **Fix:** latch failures: on any throw from compose/`enqueueWeeklyArticle`, claim the slot and `finishWeeklySlot(..., { status: "skipped" })` (the 103 CHECK already allows `skipped`; optionally add a `failed` status in a follow-up migration) with the error logged, so the slot stops refiring. Independently, run `redactSecrets`/`scanForSecrets` over post bodies in `sourceLine` before they enter the prompt.

### F-3 — Medium-Low — Mention-classifier spend is uncapped, attacker-driveable, and duplicated up to 3× per post

- **Where:** `src/weekly/classify-mentions.ts:47-55` (pulls *all* notifications for `JEB_PUBKY` + `botPk`, up to 20 pages × 30 per key, regardless of whether Jeb processed/skipped the mention), `:83` (one `classifyFeedbackPost` per URI — no `globalDailyTokens` check, no `weeklyTokenCap` check, no per-run URI cap); invoked by *both* series (`src/weekly/run.ts:57-66` and `:199-208`); mention-time classification duplicates it again (`src/weekly/persist.ts:35`, called from `src/reason.ts:356`). The only token guard lives in the updates section loop (`src/weekly/run.ts:224-232`, `storeTokensGuard`).
- **What:** any user can force one model call per mention of Jeb in the window — including mentions Jeb's reason pipeline skipped (caps, blocklist, bot_author) — and each post is classified once at mention time, again in the Sunday run, and again in the Monday run (`upsertFeedbackItem` dedupes the row, not the spend). Spend is only *recorded* (`phase=feedback`), never checked against `JEB_DAILY_TOKEN_BUDGET` or `JEB_WEEKLY_TOKEN_CAP`.
- **Impact:** cost amplification outside every documented cap (`docs/limits.md:24` claims weekly spend is capped; the classifier path is not).
- **Fix:** inside `classifyJebMentions`: pre-check `store.globalDailyTokens()` (with estimate) and `weeklyTokensUsed`, stop at a per-run URI cap, skip URIs already present in `feedback_items`, and share one classification pass between the two series (e.g. run once, read stored rows for the Jeb section). Also skip opted-out/blacklisted authors (F-5).

### F-4 — Medium-Low — Slur/person denylist is enforced at enqueue but not at the publisher signing boundary (A1 F-1 lesson applied to `approved_by`, not to labels)

- **Where:** `packages/bot-kit/src/publish/publisher.ts:412-419` (`applyArtifactTagOne` re-checks `approved_by`, `botRepliedTo`, style via `hooks.isArtifactTagLabel`, and secrets — but never `rejectOpenTagReason`); same gap for self-tags in `tagOne` (`publisher.ts:349-375`, style + secret-scrub only). Enqueue-side filtering exists everywhere (`packages/bot-kit/src/tags/apply.ts:27-34` `assertOpenLabels`, `src/tags-propose.ts:120-123` `filterOpenTags`, operator CLI `src/tags.ts:38-50` → `applyTags`).
- **What:** the repo's own trust model treats a reason-role SQL writer as untrusted at the publisher (A1 F-1 rationale, `publisher.ts:505-507`). Such a writer can insert `artifact_tags(post_uri, label='nigger', approved_by='jeb-answered')` for a post Jeb answered — or poison `publish_requests.categories` with a style-valid slur — and every boundary check passes: the label is PUT under Jeb's key. `markArtifactTagDone`/revoke machinery then treats it as legitimate.
- **Impact:** slur/person tags published under the bot key by an in-model attacker who already has reason-role DB write; the boundary validation that exists for `approved_by` is absent for label content.
- **Fix:** call `rejectOpenTagReason(label)` (personTokens optional) in `applyArtifactTagOne` before the PUT and per label in `tagOne`; on a hit, fail the row (`markArtifactTagFailed` / drop + `markTagsDone([])`) and log `security_event`.

### F-5 — Low — Opted-out and blocklisted authors are still quoted, with profile links, in weekly articles

- **Where:** `src/weekly/classify-mentions.ts:73-105` and `src/weekly/tag-collect.ts:43-74` filter only Jeb-authored and deleted content; neither consults `user_optouts` or the `blacklist` table. The reason-path classifier (`src/reason.ts:323-356`) runs *after* the opt-out/bot skips, so consent is honored there — the weekly collectors bypass it.
- **What:** a user who publicly told Jeb to stop (silent skip `optout`) can still find their post classified, stored in `feedback_items`, and quoted in the Sunday article under their `pk:` profile link.
- **Impact:** consent/privacy gap between the reply surface and the publication surface; reputational rather than exploitative.
- **Fix:** filter candidate authors against `store` opt-out and blacklist state in both collectors (and in `buildFeedbackArticle` as a backstop).

### F-6 — Low — Answered-post artifact tags are enqueued before the reply exists; the boundary fail is terminal, so a normal race silently loses the tag

- **Where:** enqueue at answer-queue time (`src/reason.ts:574-582`, before the publish request is claimed); terminal check at `packages/bot-kit/src/publish/publisher.ts:403-411` (`!answered && isAutoArtifactApprover` → `markArtifactTagFailed`; `failed` is never re-claimed, `publish-store.ts:321-333`).
- **What:** if the publisher's artifact-tag pass claims the row while the corresponding reply is still queued/retrying (backoff, many rows ahead, transient PUT failure), `botRepliedTo` is false and the row is *permanently* failed — even though Jeb does answer the post seconds later. Fails closed (no security hole), but the documented `jeb-answered` auto-approval silently no-ops exactly when publishing is degraded.
- **Fix:** treat "not yet answered" as retryable (`markArtifactTagRetry` with the existing attempt cap) rather than `failed`, or make `claimPendingArtifactTag` skip rows whose target has no published reply yet (SQL join against `handled_mentions`).

### F-7 — Low — Person denylist misses pubky *fragments* and display names; `personTokens` only ever carry raw pubkys

- **Where:** `packages/bot-kit/src/tags/denylist.ts:34-36` (`isPubkyIdTag` requires the full 52-char z32; the 20-char style cap then makes the full-id check unreachable — a full id is rejected as `style` first, `policy.ts:60-63`); callers pass only pubky ids as tokens (`src/reason.ts:535` `[author, view.details.author]`, both z32), never the author's display name/handle, despite the denylist header documenting "author name/handle/id".
- **What:** a model-proposed label that is a z32 fragment of someone's key (8–20 chars, e.g. `9o6xrx8w`) or the post author's display name (e.g. `satoshi`) passes style + denylist and can be published as a self-tag or artifact tag. The static 5-name list and exact-token equality are the only person guards that actually fire.
- **Impact:** low — opaque fragments/names as tags under Jeb's key; violates the documented "never a person" invariant (`docs/publishing.md:70`) at the edges.
- **Fix:** reject labels ≥8 chars that prefix-match any personToken or known pubky (e.g. `JEB_PUBKY`, tracked `pubky_ids`); feed the author's Nexus display name/handle (already fetched as `replierDetails` in `reason.ts:330`) into `personTokens` for both self and artifact paths.

### F-8 — Low — Quote/window integrity: deleted posts stay quoted from snapshot; window inclusion trusts client-minted post-id timestamps

- **Where:** snapshot quotes (`src/weekly/store.ts:65-93`, render uses the stored quote only — `src/weekly/feedback-article.ts:44-58`); timestamp preference `packages/bot-kit/src/crockford.ts` (`postTimestampMs` prefers the Crockford id's embedded time over Nexus `indexed_at`), consumed by `src/weekly/content.ts:23-43`, `gather.ts:137-142`, `classify-mentions.ts:77-82`, `tag-collect.ts:54-59`.
- **What:** (a) a user who deletes or edits a quoted post still appears in the Sunday article — the quote was captured at detection and is never re-validated; deletion is the only retraction mechanism on Pubky. (b) Post ids are client-generated, so an author can mint an id whose embedded timestamp lands inside (or outside) the weekly window regardless of when the post was actually written; Nexus `indexed_at` would disagree but loses.
- **Impact:** (a) consent/UX — retracted content republished under Jeb's name with a dead link; (b) window-integrity games (stale content quoted as "this week", or evasion).
- **Fix:** (a) at render time, best-effort re-fetch quoted posts and drop items that now read `[deleted]`/are gone (or explicitly document the snapshot policy in `docs/weekly.md`); (b) cross-check id-time against `indexed_at` and reject the post when they diverge beyond a small slack (e.g. 1 h).

### F-9 — Info — `weekly_posts` has no failure state or reaper: a crash between claim and finish wedges the week silently

- **Where:** `src/weekly/store.ts:172-205` (`claimWeeklySlot` / `finishWeeklySlot`), status CHECK `('queued','published','skipped')` (`migrations/103_weekly.sql:25`), loser-return path `src/weekly/publish-article.ts:44-57`.
- **What:** a process crash (or kill) after `claimWeeklySlot` but before `finishWeeklySlot` leaves `status='queued', post_uri=NULL` forever; `weeklyTick` sees the row and skips; the week never publishes and nothing alerts. (The `enqueueStandalonePost` throw path *does* delete the row — `publish-article.ts:71-77` — so only a hard crash wedges it.)
- **Fix:** reap stale `queued` rows older than the fire day (delete or mark `skipped`), and/or surface `queued`-and-old rows in health/metrics.

### F-10 — Info — `approved_by='weekly'` is a bare string sentinel, not cross-checked against `weekly_posts`

- **Where:** `packages/bot-kit/src/publish/publisher.ts:551` (`weeklyRow = ... approved_by === "weekly"`); the standalone boundary validates only non-empty `approved_by` + the content-seeded `mention_key` hash (`publisher.ts:508-534`).
- **What:** the sentinel is not validated against an actual `weekly_posts` origin row. Exploiting it requires DB write, and such a writer can equally set `approved_by='op'` — the hash + outbound gate + kill switches are the real boundary — so the practical delta is only *which* switch (`weekly` vs `proactive`) gates the forged row. The `jeb-answered` sentinel, by contrast, *is* origin-checked (`botRepliedTo`, `publisher.ts:403-404`) — the asymmetry is worth closing or documenting.
- **Fix:** optional hardening: for `approved_by='weekly'`, require a matching `weekly_posts.mention_key = row.mention_key` row at the boundary; otherwise document the accepted equivalence in `docs/publishing.md`.

---

## Verified properties

**Q1 — autonomous path & sentinels.**
- The A1 F-1 boundary holds and is extended: standalone rows require non-empty `approved_by` *and* a `mention_key` equal to the content-seed hash, re-verified in `publishOne` (`publisher.ts:508-534`); failures are loud, logged as `security_event`, and never PUT.
- `jeb-answered` is validated at the signing boundary against origin, not just string-matched: `botRepliedTo` reads Jeb's own `handled_mentions` (`status='published' AND reply_uri IS NOT NULL`, `src/db.ts:1005-1014`) — not Nexus or any attacker-influenceable source. Unanswered targets with the sentinel are failed permanently (`publisher.ts:403-411`); operator `approved_by` is unaffected.
- `weekly` switches the gate from `proactiveBlocked` to `weeklyBlocked`, checked twice before the PUT (`publisher.ts:551-578`); no other code path enqueues with `WEEKLY_APPROVED_BY` (grep: only `src/weekly/publish-article.ts:68`).
- Week-key idempotency is race-safe for two reason processes: `INSERT ... ON CONFLICT (series, week_key) DO NOTHING` is atomic (`store.ts:172-185`, PK in `103_weekly.sql:28`); the loser returns the existing row without enqueuing (`publish-article.ts:44-57`). The enqueue-throw cleanup (`:71-77`) is correctly scoped to the winner's own un-finished row. (Losers waste one compute pass; crash-wedge caveat is F-9.)
- Reply-then-tag amplification is bounded: artifact targets must be posts Jeb actually replied to (own DB rows), labels are composed from Jeb's own reply text and filtered (`tags-propose.ts:116-135`); there is no path to tag an arbitrary third-party post.

**Q2 — quoted content.**
- Quote pipeline is solid: `screenToolResult` (280 cap + injection detect + secret redact, `tool-screen.ts:31-73`) → instruction-phrase stripping → `sanitizeUntrustedDraftText` (strips control/zero-width chars, markdown links/images/autolinks, bare http(s)/www, `pubky://` URIs, bare 52-char keys; collapses to one line) → 280 cap → `[filtered]` fallback (`sanitize-quote.ts:21-27`, `drafts/finish.ts:112-136`). Residue cannot form a link, image, mention, or multi-line construct in the article.
- Author pubkys and post URIs are regex-validated before rendering, with a harmless placeholder fallback (`feedback-article.ts:54-58`); links are rebuilt as `pubky.app` URLs (`links.ts`), never attacker URLs.
- Updates bullets are constrained to an exact-match allowlist of app URLs derived from the confirmed candidates (`updates-article.ts:152-169`); model-invented hrefs, images, and reference-style links are dropped; `IRRELEVANT_BULLET_RE` and `rewriteProjectPubkys` run after; the whole article then passes `lintVoice` + `scanOutboundText` (`publish-article.ts:21-28`).
- Model output parsing is fail-closed: `parseRelevance` requires a JSON object with boolean `relevant` (`updates-article.ts:118-134`); `parseFeedbackClassification` enum-filters kinds via `isFeedbackKind` and sanitizes the model's quote (`classify.ts:38-56`). Unparseable output is dropped, never rendered.
- Project `pubky_ids` are Z32-validated at the operator CLI (`projects-cli.ts:35-42`); learned candidates carry none (`learn.ts:112-119`) and never render sections (`run.ts:212`).

**Q3 — classifier/summariser.** System prompts carry explicit data-not-instructions framing; relevance and classification parses are strict as above; summariser output is link-allowlisted. Section-level caps are enforced before each `writeProjectSection` (`run.ts:224-232`, `278-289`: per-week cap + global daily budget with headroom). Gap filed as F-3 (classifier path uncapped) and F-2 (unredacted bodies into prompts).

**Q4 — open tag vocabulary.** Style rule is anchored (`/^[a-z0-9]+(?:-[a-z0-9]+)*$/`, ≤3 hyphen words, ≤ min(32, spec 20) chars — `policy.ts:29-42`); slur list covers compounds (`denylist.ts:60-70`); person static list + normalized token equality; pubky ids (full) and secret-scrubber hits rejected; 5-tag cap; Nexus-alias remapping is string-equivalence only (`preferExistingTags`). All enqueue paths — auto, operator CLI, kit — pass through `rejectOpenTagReason`/`filterOpenTags`. Publisher boundary checks style + secrets; denylist-at-boundary gap filed as F-4; fragment/display-name gaps as F-7.

**Q5 — collections.** PUTs are idempotent (deterministic `collectionPostId`/`collectionMentionKey` from the title, `post.ts:69-76`; `supersedePublishForReplace` keeps only the newest envelope, `publish-store.ts:115-121`); items are validated (`pubky://` prefix) and capped at the spec limit at PUT time (`post.ts:85-98`); rule matching keys off Jeb-chosen state only — weekly series tags, operator/seed project tags, and draft self-tags — replies never trigger appends (hook is standalone-only, `publisher.ts:666`); `rebuild` only replaces `collection_items` and re-enqueues (no deletion of `published` rows or posts, `collections-maintain.ts:122-143`); the `collections` switch is honored in reconcile/append/rebuild *and* at the publisher PUT (`publisher.ts:558-560, 576-578`). Item-count growth past the cap is F-1.

**Q6 — kill switches.** `weekly` is honored at the scheduler tick (`loop.ts:20`), the CLI (env + DB, `cli.ts:46-54`), and twice at the publisher; catch-up after restart re-checks the switch before firing. `collections` as above. `store.switchOn` DB errors propagate and abort the tick/PUT (fail-closed; no swallow found). Admin surface: new switch names accepted (`health.ts` `SWITCH_ALLOWED`), bearer or `SameSite=Strict; HttpOnly; Path=/admin` cookie, drafts POSTs require a double-submit CSRF token (`dashboard-drafts.ts:31-43`) — cross-site cookie POSTs are blocked by SameSite=Strict.

**Q7 — privacy.** No log line prints raw post bodies, env values, or key material; the noisiest lines are a sanitized 80-char quote (`classify-mentions.ts:98`) and 160-char dropped model bullets (`updates-article.ts:144,163`). `feedback_items` stores only public data (post URI, author pk, ≤280-char sanitized quote). Consent gap filed as F-5; deletion-snapshot gap as F-8.

**Q8 — migrations.** 103 and 107 are additive and idempotent (`CREATE TABLE IF NOT EXISTS`, `INSERT ... ON CONFLICT DO NOTHING/DO UPDATE`); NOT NULLs, `UNIQUE(post_uri)`, PK `(series, week_key)`, CHECKs on enums, week-key shape, and quote length are present; the non-empty `approved_by` CHECK on `artifact_tags` (102) is untouched; 104 backfills the Jeb key omitted from the 103 seed (drift resolved, code fallback in `types.ts:70-84` agrees). No drops, no rewrites, no data-loss paths.

**Regression check on closed findings.** A5r F-N1/F-N2/F-N4 fixes are present and intact: `markArtifactTagRetry`/`markArtifactTagFailed` guard `status <> 'revoked'` (`publish-store.ts:336-360`), `revokePostTag` marks-before-delete (`publisher.ts:294-313`), rollback DELETEs are try/caught (`publisher.ts:432-445`, `apply.ts`), `failExhaustedArtifactTags` runs each tick (`publisher.ts:742`). A1 F-1 and A5 F-1 boundaries both hold (above).

## Not covered

- DB-backed test suites (`idempotency.test.ts`, `cli.test.ts`, `publish.test.ts`) were read but not executed — no writable Postgres in this environment; race-ordering findings (F-1, F-6) are from statement-order analysis, not live reproduction.
- Multi-publisher-process deployments (single publisher assumed, as in A5r).
- `ai-sdk` `generateText` internals, Nexus ranking/search behavior, and homeserver storage semantics (library trust boundaries, as in A5/A5r).
- `src/dashboard-drafts.ts` beyond the auth/CSRF surface reachable from `health.ts` (draft generation is A2/A3 territory; the 2026-09-05b draft formats in this diff were spot-read only).
- Dry-run render fixtures under `docs/weekly-dryrun-*/` and `docs/drafts-review-*/` were not re-derived.
- `docs/pubchi-design.md` (1,939-line design doc) is out of threat scope and was not reviewed.

## Remediation

Implemented 2026-09-05 on `stage2/audit-a6a7-fix` (worktree `pubky-ai-bot-harden`).

| Finding | Commit |
|---|---|
| F-1 hook try/catch, `markPublishRetry` published guard, newest-N cap, per-rule reconcile | `2044d4d` (cap/retry/reconcile); `8f6beb4` (hook try/catch) |
| F-2 latch weekly compose failures; redact `sourceLine` | `47eca21` |
| F-3 classifier spend caps, skip stored URIs, one pass, skip excluded authors | `c0005af` |
| F-4 denylist at signing (`tagOne` / `applyArtifactTagOne`) | `8f6beb4` |
| F-5 opt-out/blocklist in collectors and `buildFeedbackArticle` | `962a51f` |
| F-6 unanswered artifact tags retryable | `8f6beb4` |
| F-7 person-prefix denylist + display-name tokens | `8f6beb4` |
| F-8 refetch-drop deleted/gone quotes; 1h id vs `indexed_at` slack | `9ee4d27` (slack); `962a51f` (refetch) |
| F-9 reap stale `queued` weekly slots; health count | `39a5bde` |
| F-10 `approved_by='weekly'` requires `weekly_posts.mention_key` | `8f6beb4` |
