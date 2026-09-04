# Kimi External Audit A3 — Re-audit of A1/A2 Remediation

Scope: re-verification of every claim in the `## Remediation 2026-09-04` sections of
`docs/kimi-audit-a1-publisher-2026-09-04.md` and `docs/kimi-audit-a2-drafts-2026-09-04.md`
against `git diff ba3ee38..HEAD` and the current tree, plus a targeted regression hunt on the
fix code itself. Read-only worktree; no source modified. Tests were verified by reading
(no Postgres available in this worktree; suite not executed).

## Verdict: SHIP

All twelve actionable findings from A1 and A2 are closed with code, tests, and docs, and the
shipped state keeps proactive drafts operator-off (`JEB_DRAFTS_ENABLED` must be `1`,
src/drafts/generate.ts:17-19; per-format envs off by default, src/drafts/types.ts:61-68;
docs/proactive.md). The residual risk is the one A1 already flagged: a reason-role process
with SQL write access can satisfy the new approval check itself (F-N1) — the tree ships the
mitigation hook (`JEB_DB_URL_REASON`) but does not enforce its use. That is a deployment
hardening item, not a blocker for shipping this tree with proactive drafts operator-off.

## Per-finding status

| Finding | Status | Evidence (verified in current tree) |
|---|---|---|
| A1 F-1 (approved_by not checked at trust root) | CLOSED (residual → F-N1) | `approved_by` added to claim row type/SELECT/map: packages/bot-kit/src/publish/publish-store.ts:36, 163-166, 186. `standaloneMentionKey` exported: packages/bot-kit/src/publish/publisher.ts:143-150. Refusal of null/empty `approved_by` for all standalone rows: publisher.ts:419-428. `mention_key` ≠ content-seed hash refusal for short/long: publisher.ts:429-445. Tests: src/publish.test.ts:1049-1075 (unapproved standalone, 0 PUTs, status failed), 1077-1102 (unapproved collection), 1104-1121 (approved publishes), 1123-1149 (mention_key mismatch). |
| A1 F-2 (scripts/post.ts ignores proactive switch) | CLOSED | `loadWriteSwitches` resolves env+store replies/global/proactive: scripts/post.ts:79-103 via packages/bot-kit/src/publish/post.ts:38-50; passed as `proactiveSwitchOn`: scripts/post.ts:187-192. Tests: src/post.test.ts (`resolvePostPublishSwitches combines env and store bits…`, `refuses publish when JEB_SWITCH_PROACTIVE=1`). |
| A1 F-3 (--delete bypasses kill switches) | CLOSED | replies/global gate before delete (non-dry-run): scripts/post.ts:133-136; header documents coverage incl. proactive exemption for delete: scripts/post.ts:17-20. Contract-mode gate still first: scripts/post.ts:129. Test: `refuses --delete when replies switch is on`. |
| A1 F-4 (--edit converts reply → standalone silently) | CLOSED | Preflight GET of target path + stderr warning when existing JSON has `parent`: scripts/post.ts:201-215 (after transport open, before any PUT at 216-221). |
| A1 F-5 (NODE_OPTIONS inherited by no-key children) | CLOSED | Removed from `SYSTEM_PASS`: packages/bot-kit/src/security/keys.ts:56 (`["PATH","HOME","TZ","LANG"]`). Tests assert `NODE_OPTIONS` undefined: src/keys.test.ts:69, 98. |
| A1 F-6 (migration 100 ADD CONSTRAINT not idempotent) | CLOSED | `DROP CONSTRAINT IF EXISTS scout_canary_outcome_chk` prepended: src/infrastructure/database/migrations/100_scout_canary.sql:16. |
| A1 F-7 (099 column drops informational) | N/A — recorded | No action required; audit trail stands. |
| A2 F-1 (daily cap raceable across concurrent approves) | CLOSED | `pg_advisory_xact_lock(JEB_PROACTIVE_CAP_LOCK)` inside the approve transaction before row lock and cap count: src/db.ts:836-840 (lock key constant src/db.ts:66 = 2016090401). Pre-transaction read removed from src/drafts/publish-request.ts:25-41. Test: src/drafts/drafts.test.ts:356-377 (concurrent approves → exactly one succeeds, loser gets /daily cap/). Unique-index alternative correctly rejected (cap is configurable >1; documented migration 101:3-8, docs/proactive.md). |
| A2 F-2 (raw graph text into publishable bodies) | CLOSED (residual → F-N2/F-N3) | Sanitizers: src/drafts/finish.ts:28-30 (`sanitizeDraftLabel`, whitelist `/[^a-zA-Z0-9_-]/g` max 20 — matches Scout tools.ts:278 exactly), 38-44 (`sanitizeUntrustedDraftText`: control-strip, markdown link/image/autolink URL drop, pubky://+bare-pk strip, bare http(s) drop, whitespace collapse). Body-level `neutralizeDraftBody`: finish.ts:64-66. Evidence hrefs prepended ahead of the 3-citation cap: finish.ts:88-93. Applied at every graph-text interpolation: what-changed.ts:12,21; thread-worth-reading.ts:25; the-disagreement.ts:18,30; new-connection.ts:16; pubky-explained.ts:21. Tests: drafts.test.ts:421-468 (phishing markdown neutralized + evidence first; newline label collapsed; fake pubky:// stripped). |
| A2 F-3 (no-autonomous tripwire weak/test-only) | CLOSED | Directory scan of every `.ts`/`.js` in src/drafts with empty-list fail: src/drafts/no-autonomous.ts:21-36; broader regex covers SQL `SET status='published'` and JS `status:'published'` (19); db.ts ownership checks incl. `decided_by`/`approved` (37-46); startup invocation at drafts-role entry: src/drafts/cli.ts:30; DB-level backstop CHECK `drafts_decided_by_required`: migration 101:19-23. Notes: `PUBLISH_STATUS_ALLOWLIST` (no-autonomous.ts:8) is now an unused export; the regex remains evadable by string concatenation — accepted, the 101 CHECK is the hard guarantee. |
| A2 F-4 (approve enqueues pre-transaction body) | CLOSED | Enqueue callback signature takes the `FOR UPDATE` row: src/db.ts:829-832, passed at 861 (`opts.enqueue(client, current)`); body sourced from `locked.body`: src/drafts/publish-request.ts:35-40. Pre-transaction `getDraft`/cap pre-check deleted. |
| A2 F-5 (identical-body approve silently links old request) | CLOSED | `inserted === false` → ROLLBACK with `identical content already queued/published as request #N`: src/db.ts:867-870. Test: drafts.test.ts:379-392 (draft B stays `draft`, no link). |
| A2 F-6 (scrubbed draft marked published; stats skewed) | CLOSED | `declined` status: migration 101:14-17 (CHECK includes `declined`), src/drafts/types.ts:23. Publisher marks declined when `row.scrubbed === true \|\| content === decline`: packages/bot-kit/src/publish/publisher.ts:560-564 (decline substitution verified at 487-509; covers both pre-scrubbed and freshly-flagged rows). `markLinkedDraftDeclined` guard mirrors published (approved + non-empty decided_by): src/db.ts:941-947. Reception excludes non-published and scrubbed rows: src/drafts/stats.ts:66-67; declined counted separately: src/db.ts:949-978, stats.ts:85-105. Test: drafts.test.ts:394-418. Note (design, documented in docs/proactive.md): `declined` rows count against the daily cap (src/db.ts:810, 853) — a scrubbed draft burns the day's slot; conservative and intentional. |

## Regression checks on the fix code

### (a) Can a reason-role process satisfy the new approval check itself? — YES

Plainly: **DB-write access from reason remains the residual risk.** The trust root now requires
(i) non-empty `approved_by` (publisher.ts:420-428) and (ii) `mention_key` equal to
`standalone:<sha256(JSON({content,kind,attachments,collectionId}))>` (publisher.ts:429-445,
seed construction 128-140). Both are satisfiable by any process that can INSERT into
`publish_requests`: the hash is deterministic over the attacker's own row content with no
secret input, and `approved_by` accepts any non-empty string. So the fix defeats the A1
exploit as written (`approved_by=NULL` rows) and forces structural self-consistency, but a
deliberate reason-role SQL writer can still self-approve a standalone row. See F-N1 for the
closure: `JEB_DB_URL_REASON` (wired at packages/bot-kit/src/security/keys.ts:169-174) pointing
at a PG role with **column-level** grants — INSERT on `publish_requests` limited to the reply
columns (mention_key, parent_uri, content, evidence_id, categories), excluding
`approved_by`/`standalone`/`post_kind`/`attachments`/`collection_id`/`replace_post_id`, and no
UPDATE — makes every reason-written row land `standalone=false, approved_by=NULL`, at which
point the publisher's check becomes a real boundary. Without the operator wiring that URL, the
check is raising-the-bar only.

### (b) Advisory lock key / migrator deadlock — CLEAN

`JEB_PROACTIVE_CAP_LOCK = 2016090401` (src/db.ts:66) is a constant, taken with the
transaction-scoped `pg_advisory_xact_lock` *inside* the transaction (BEGIN at src/db.ts:836,
lock at 840) and auto-released on COMMIT/ROLLBACK. The migrator holds a session-level lock
with a different key (`JEB_MIGRATION_LOCK = 746283901`,
src/infrastructure/database/migrator.ts:14, 54) and never touches draft rows or the cap lock,
so no cross-key cycle exists. Lock ordering inside approveDraft is uniform (advisory →
`FOR UPDATE` row lock); the only other draft writers are single-statement UPDATEs
(`rejectDraft` src/db.ts:901-910, `markLinkedDraft*` 929-947) that never take the advisory
lock and hold at most one row lock — no wait-for cycle possible. Concurrent approves now
serialize fully: the loser's cap COUNT executes only after the winner commits, so under READ
COMMITTED it sees the winner's row and rolls back (test drafts.test.ts:356-377).

### (c) Sanitizer bypass vs `rewritePubkyCitations` — NO EXPLOITABLE BYPASS

Key invariant verified: the promotion set of `rewritePubkyCitations` (src/links.ts:5-7:
literal `pubky://` post/profile URIs + bare 52-consecutive-char pks) is a subset of the
sanitizer's strip set for untrusted text (finish.ts:24-25), and untrusted segments are
sanitized before assembly, so nothing attacker-controlled survives to be promoted.

- **`pubky:` casing** — covered: `PUBKY_URI` has the `i` flag (finish.ts:24); links.ts regexes
  are likewise case-insensitive.
- **Percent-encoding (`pubky%3A//…`)** — survives the sanitizer, but `rewritePubkyCitations`
  requires the literal scheme and also misses it → remains inert literal text. Info only.
- **52-char pk split by zero-width chars** — both sanitizer and rewriter require 52
  consecutive `[a-z0-9]`; a U+200B-split pk stays literal text (zero-width chars are not in
  `CONTROL_EXCEPT_NL_TAB`, finish.ts:20). Inert today; noted in F-N2.
- **Unicode lookalikes for `[`/`(`** (fullwidth ［］（） etc.) — the markdown regexes are
  ASCII-only so the brackets survive, but in `sanitizeUntrustedDraftText` `dropBareHttp`
  (finish.ts:60-62) removes *all* http(s) URLs from untrusted segments regardless of bracket
  style, so the payload is gone; and no CommonMark renderer treats fullwidth brackets as link
  syntax. Inert.
- Verified every generator interpolation of graph-sourced strings routes through a sanitizer:
  what-changed.ts:12,21; thread-worth-reading.ts:25; the-disagreement.ts:18,30;
  new-connection.ts:16; pubky-explained.ts:21. Residual raw interpolations are enumerated in
  F-N3 (all structurally constrained by data provenance).
- Evidence-link ordering: `finishDraft` prepends ≤3 evidence hrefs before the body
  (finish.ts:88-93), so the voice citation cap cannot evict them; attacker URLs past the cap
  are dropped, never reordered ahead (test drafts.test.ts:427-439).

### (d) `declined` status vs allowlists/enums elsewhere — CLEAN

All draft-status enumerations updated consistently: `DRAFT_STATUSES` (src/drafts/types.ts:23),
CLI `--status` validation now driven off it (src/drafts/cli.ts:62-63), DB CHECK dropped and
re-added to include `declined` (migration 101:14-17, with `drafts_decided_by_required`
covering `declined` at 19-23), cap counts include it (src/db.ts:810, 853),
`draftCountsByFormat`/stats extended (src/db.ts:949-978, src/drafts/stats.ts:12, 85-105),
`mapDraftRow` types status as the new union (src/db.ts:983-1011). Write paths guard on
`status='approved'` + non-empty `decided_by` for both `published` and `declined` transitions
(src/db.ts:916-947), so a declined draft is terminal and cannot be re-approved or
double-counted as published. rg over src/ found no other drafts-status allowlist. The
`publish_requests` status enums are untouched. No breakage found.

## New findings

### F-N1 — Low — Publisher approval check is self-satisfiable by any `publish_requests` writer; closure requires per-role DB URL + column grants (operator action)

- **Where:** packages/bot-kit/src/publish/publisher.ts:419-445 (check);
  packages/bot-kit/src/security/keys.ts:169-174 (`JEB_DB_URL_REASON` optional); reason child
  otherwise inherits full-power `DATABASE_URL` (keys.ts:64-95 area, unchanged from A1).
- **Exploit path (residual):** a future SQL-writing bug in the LLM-facing reason process
  inserts `standalone=true, post_kind='short', replace_post_id=<13 valid chars>,
  content=<non-secret text>, approved_by='x',
  mention_key=standalone:<sha256 of the seed it computes itself>`. The new trust-root check
  passes; scrubber and kill switches still apply, but the human-approval boundary is again
  nominal. The A1 fix raised the cost from "leave approved_by NULL" to "compute a public hash
  and set a non-empty string" — worthwhile, but not a boundary against a deliberate writer.
- **Fix:** deploy with `JEB_DB_URL_REASON` pointing at a dedicated PG role, and grant that
  role INSERT on `publish_requests` **per column** for the reply path only
  (mention_key, parent_uri, content, evidence_id, categories), omitting `approved_by`,
  `standalone`, `post_kind`, `attachments`, `collection_id`, `replace_post_id`, `scrubbed`,
  with no UPDATE/DELETE. Reason-written rows then physically cannot carry approval, and the
  publisher check (publisher.ts:420-428) becomes a true enforcement point. Consider a
  migration or runbook note asserting the grant when `JEB_DB_URL_REASON` is set.

### F-N2 — Info — Sanitizer/rewriter inert residuals: percent-encoded `pubky%3A//`, zero-width-split pks, scheme-less `www.` domains

- **Where:** src/drafts/finish.ts:20-26 (regex sets), src/links.ts:5-7 (promotion regexes).
- **Exploit path:** none today. `pubky%3A//<pk>/…` and a 52-char pk interrupted by zero-width
  characters (U+200B etc., not stripped by `CONTROL_EXCEPT_NL_TAB`) survive
  `sanitizeUntrustedDraftText`, but `rewritePubkyCitations` also fails to recognize both, so
  they publish as literal text — clickable only if a future client normalizes
  percent-encoding/zero-widths before linkifying. Separately, scheme-less `www.evil.example`
  in a post preview survives (no scheme for `HTTP_SPLIT` to match); GFM-style autolinkers
  would render it as a link, though the visible text is the domain itself (no label disguise,
  unlike the A2 F-2 markdown case).
- **Fix:** optional hardening — strip Cf/format characters (`\p{Cf}`) and percent-encoded
  scheme variants in `sanitizeUntrustedDraftText`; drop bare `www\.` prefixes alongside
  `dropBareHttp` if the rendering surface is found to autolink them.

### F-N3 — Info — Raw-on-mismatch fallthroughs in link builders; minor unsanitized fields (all currently constrained by provenance)

- **Where:** `evidenceHref` returns the input verbatim when it matches neither pubky pattern
  (src/drafts/finish.ts:74) and the result is *prepended* as a first-class evidence link
  (88-92); `postLink` likewise returns raw on mismatch (src/drafts/scout-util.ts:22);
  `profileAppUrl(a)` interpolates scout `author_id` with no 52-char shape check
  (src/drafts/new-connection.ts:37); `first.status` and `cites` are embedded without
  `sanitizeUntrustedDraftText` (src/drafts/pubky-explained.ts:28-29 — note
  `neutralizeDraftBody` preserves newlines, so a newline-bearing `status` would inject lines).
- **Exploit path:** none reachable today — scout-sourced URIs/author ids are structurally
  constrained by the indexer (`pubky://<pk>/pub/pubky.app/posts/<id>` / 52-char pks),
  pubky-explained reads the operator's own knowledge corpus
  (src/drafts/generate.ts:56-67), and release-radar's `tag_name` is constrained by git ref
  rules (no whitespace/control) with URLs from the GitHub API. These are defense-in-depth
  gaps, not live injection paths.
- **Fix:** return `""` (or drop the entry) on pattern mismatch in `evidenceHref`/`postLink`;
  assert `/^[a-z0-9]{52}$/` on author ids before `profileAppUrl`; run
  `sanitizeUntrustedDraftText` over `first.status` in pubky-explained.

KIMI_AUDIT_A3_COMPLETE
