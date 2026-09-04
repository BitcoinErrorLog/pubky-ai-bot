# Kimi External Audit A1 — Publisher Write Paths

Scope: PUBLISHER WRITE PATHS only (src/publish.ts, src/post.ts, src/tags.ts, src/collections.ts,
src/outbound-gate.ts, src/modes.ts, src/main.ts, scripts/post.ts, scripts/profile.ts,
migrations 097–100, packages/bot-kit/src/security/keys.ts), plus the path-construction and
store helpers they delegate to (src/homeserver.ts, src/reply-tags.ts, src/upload.ts,
packages/bot-kit/src/types.ts, src/db.ts, src/requeue.ts, src/reason.ts, migrator).

## Verdict: FIX-FIRST

One required fix (F-1, Med): the publisher — documented as the single trust root — never
re-validates `approved_by` on standalone/collection rows, so the "operator-approved only,
never auto-published" invariant is enforced at enqueue time but not at the signing boundary.
Everything else is sound: no path escape was found, all row-controlled path components are
shape-checked before interpolation, the outbound gate covers every publisher write family,
and the env allowlists carry no bot key material. F-1 is a ~5-line fix (select `approved_by`
in `claimPublish`, refuse standalone rows without it).

---

## Threat question 1 — Can a publish_requests row write outside `/pub/pubky.app/{posts,tags,files,blobs}/<13-char id>`?

**No.** Every write family was traced:

- **Reply posts** — path is `${POSTS_PREFIX}${id}` where `id` is either the library-generated
  `meta.path` (pubky-app-specs emits `/pub/pubky.app/posts/<13-char>`, pubky_app_specs.d.ts:376-381)
  or `replace_post_id` (src/homeserver.ts:167-169). `replace_post_id` is re-validated at the
  trust boundary: src/publish.ts:313-324 rejects anything failing `/^[A-Z0-9]{13}$/`, fails the
  row loudly, and never PUTs (regression test with `"../../etc/passwd"`: src/publish.test.ts:800-825).
- **Standalone posts** — src/publish.ts:391 requires `replace_post_id`; path rebuilt via
  `buildStandalonePost(..., editId)` → `parseEditId` re-checks `/^[A-Z0-9]{13}$/`
  (src/post.ts:180-188, 192-196) and emits `/pub/pubky.app/posts/${id}`. Double validation.
- **Collections** — same edit-id path (src/post.ts:105-116, src/homeserver.ts:197-207);
  item URIs are re-validated at publish time (`assertCollectionItems`: non-empty, cap,
  `pubky://` prefix, src/post.ts:64-77 via src/publish.ts:402-411).
- **Reply self-tags** — `putReplyTags` refuses any URI whose author ≠ bot key
  (src/reply-tags.ts:146-149), labels are shape- and vocab-checked (157-160), tag path is
  library-built `/pub/pubky.app/tags/<hash(uri+label)>`.
- **Artifact tags** — `artifactTagObject` re-runs `parsePostUri` (strict canonical regex,
  packages/bot-kit/src/types.ts:47-51) and the vocab check (src/reply-tags.ts:173-190);
  the tag object is always written under the **bot's own** `/pub/pubky.app/tags/` even when
  the *target* post is someone else's (that is the designed feature, not an escape).
- **Blob/file paths** — only the operator scripts PUT bytes, via `planFileUpload` →
  pubky-app-specs `createBlob`/`createFile` (src/upload.ts:102-122; library paths
  `/pub/pubky.app/blobs|files/<id>`). No `publish_requests` field ever reaches a blob/file
  path; row `attachments` are URIs embedded in post JSON, count-capped only
  (src/post.ts:154-158, src/publish.ts:414).
- **`parent_uri` / `mention_key`** — `validatePublishShape` (src/publish.ts:38-50) requires
  canonical post URIs for non-standalone rows; standalone `mention_key`
  (`standalone:<sha256>`, src/publish.ts:100) is never interpolated into a path — it is a DB
  dedupe key only.
- **Defense in depth under all of the above:** every write goes through
  `session.storage.putJson/putBytes/delete` (src/homeserver.ts:68-82) signed by the bot
  keypair, so the homeserver confines writes to the bot's own keyspace even hypothetically.
  `/pub/pubky.app/profile.json` is written only by scripts/profile.ts (operator tool), never
  from a `publish_requests` row.

## Threat question 2 — Can a reason-role process cause an arbitrary homeserver write by shaping a row?

**Not an arbitrary write; but it can cause an *unapproved* write — see F-1.**

What the publisher **re-validates** (does not trust the row): `replace_post_id` shape
(src/publish.ts:317), `parent_uri`/`mention_key` canonical shape for replies
(src/publish.ts:44-50), content through `scanOutboundText` incl. prompt-echo shingles
(src/publish.ts:372, src/outbound-gate.ts:57-62), replies+global switches twice and proactive
for standalone (src/publish.ts:337-354), collection envelope structure (src/publish.ts:393-401),
standalone-must-have-replace-id (src/publish.ts:391), reply-tag author == bot key
(src/reply-tags.ts:147), artifact tag URI + vocab (src/reply-tags.ts:178-180).

What the publisher **trusts**: the `standalone` flag itself, `post_kind` (anything
non-`collection`/non-`long` degrades to `short`, src/publish.ts:413), attachment URIs (count
only), the `scrubbed` flag (src/publish.ts:364 — but that only swaps in the safe constant
`SECRET_DECLINE_REPLY`), and — critically — **`approved_by`, which `claimPublish` never even
SELECTs** (src/db.ts:547-559) and `publishOne` never checks (src/publish.ts:273-442).

Reason's own code path is well-behaved (inserts non-standalone rows only, src/reason.ts:562-569;
`replace_post_id` from work payloads is shape-checked at src/reason.ts:45-51 and requeue
requires a bot-authored reply URI, src/requeue.ts:84-93; reason holds no key material —
src/main.ts:44-45, src/reason.ts:54, keys.ts:29-37). But the reason child receives full-power
`DATABASE_URL` by default (keys.ts:64-95; per-role `JEB_DB_URL_REASON` is optional,
keys.ts:169-174), so any future SQL-writing bug in that LLM-facing process becomes an
unapproved-publish primitive because the trust root doesn't check approval.

## Threat question 3 — Does any standalone/collection/tag write bypass the outbound gate?

**No bypass of the blocking gates in the publisher.** Standalone and collection rows pass
`scanOutboundText(row.content)` exactly like replies (src/publish.ts:362-386); a flagged
collection is failed rather than declined (366-368, 380-383 — correct, a decline is not a
valid envelope). Reply tags re-check the replies switch and scrub each label
(src/publish.ts:220-234); artifact tags check replies+proactive switches and scrub the label
(src/publish.ts:258-267); the tick also re-checks switches before each tag pass
(src/publish.ts:524, 536). Operator scripts gate too: scripts/post.ts:116 (`assertOutboundClean`),
scripts/profile.ts:95, upload bytes via `assertUploadBytesClean` (src/upload.ts:86-89,
scripts/post.ts:135, scripts/profile.ts:81). Voice lint is advisory everywhere it runs
(scripts/post.ts:70-75, 141 — "warnings … do not block"), so there is no blocking voice gate
to bypass. Two operator-script gaps: F-2 (proactive switch never checked), F-3 (--delete
exempt from switches).

## Threat question 4 — Migrations 097–100

- **097** (drafts + `standalone`/`post_json`/`post_path` columns): all `IF NOT EXISTS`; the
  duplicate `standalone` add vs 098:5 is order-safe. Non-destructive.
- **098**: adds nullable columns with `IF NOT EXISTS`; creates `artifact_tags` plus the partial
  unique index `artifact_tags_active_uri_label` (098:25-27) that backs exactly-once tag apply
  (`ON CONFLICT ... WHERE status IN (...)` matches it, src/db.ts:726).
- **099**: the only destructive step — `DROP COLUMN IF EXISTS post_json, post_path`
  (099:4-5). Verified safe: no code reads or writes those columns anywhere outside the two
  migrations (grep of src/); the publisher rebuilds posts from `post_kind`/`attachments`/
  `replace_post_id` (src/publish.ts:389-417, src/db.ts:500-521). Irreversible but the columns
  were never populated by any shipped code path.
- **100**: `ADD CONSTRAINT` is not SQL-idempotent (100:16-18, no `DROP CONSTRAINT IF EXISTS`);
  safe in normal operation because the migrator runs each migration exactly once under an
  advisory lock (src/infrastructure/database/migrator.ts:51-104), but see F-6.
- **Exactly-once guards intact**: `publish_requests_active_mention_key` partial unique index
  (migration 050:31-33) is untouched by 097–100; no idempotency key or unique constraint is
  dropped or weakened. Draft approval is transactional with a daily cap
  (src/drafts/publish-request.ts:22-45).

## Threat question 5 — scripts/post.ts --delete / --edit ownership and dry-run honesty

- Both flags funnel through `parseEditId` (`/^[A-Z0-9]{13}$/`, src/post.ts:192-196;
  scripts/post.ts:105, 119), so no path traversal; the resulting path is always
  `/pub/pubky.app/posts/<id>` **under the bot key** (scripts/post.ts:84), and the homeserver
  enforces keyspace, so a post not owned by the bot key cannot be deleted or edited — the
  transport can only sign for its own key (src/homeserver.ts:130-144).
- `--keep-attachment` / `--image-uri` are pinned to `pubky://<botPk>/pub/pubky.app/files/<13-char>`
  (src/post.ts:198-205, scripts/profile.ts:73-75).
- Dry-run is honest: `--delete` prints `would delete:` and returns before any transport
  (scripts/post.ts:85-88); publish dry-run prints planned blob/file paths + post JSON and
  returns before `openTransport` (scripts/post.ts:143-153); profile dry-run likewise
  (scripts/profile.ts:97-106). No network, no key required in dry-run.
- Caveats recorded as F-3 (delete runs before the switch check) and F-4 (edit can overwrite a
  reply id with a parent-less standalone post).

## Threat question 6 — keys.ts allowlists

**No allowlisted variable carries bot key material or a path to it.** `PUBKY_BOT_*` (all three
key sources, keys.ts:12-27), `JEB_SIGNUP_TOKEN`, `ADMIN_TOKEN`, `JEB_ADMIN_PORT`, and
`JEB_HOMESERVER` are all absent from `SHARED_ALLOWLIST`/`REASON_ALLOWLIST`/`INGEST_ALLOWLIST`
(keys.ts:64-152); `INGEST_ALLOWLIST = SHARED_ALLOWLIST` (152). Present secrets are third-party
API keys the reason role genuinely needs (`JEB_MODEL_API_KEY`:113, `JEB_EMBED_API_KEY`:122,
`JEB_BRAVE_API_KEY`:144) — and all are covered by the publisher's value-matched scrubber
(`SECRET_ENV_NAMES`, packages/bot-kit/src/security/secret-scrub.ts:103-112), so they cannot be
republished. `DATABASE_URL` (65) hands DB credentials to both children by design, with optional
per-role PG users (169-186). `JEB_BLOCKLIST`/`JEB_KNOWN_BOTS` are CSV values, not file paths
(src/config.ts:204-210). One passthrough worth tightening: `NODE_OPTIONS` in `SYSTEM_PASS`
(keys.ts:56) — F-5.

---

## Findings

### F-1 — Med — Publisher never checks `approved_by`; standalone/collection approval is enqueue-only

- **Evidence:** `publishOne` row shape and body contain no approval check
  (src/publish.ts:277-291, 273-442); `claimPublish` does not select `approved_by`
  (src/db.ts:547-559); the column is nullable (migrations/098:9); the non-empty check exists
  only in the enqueue helpers (src/publish.ts:94-95, 132-133); design docs state
  "operator-approved only. Never auto-published." (migrations/097:1, src/publish.ts:79-82).
- **Exploit path:** any process/bug with write access to `publish_requests` (the reason child
  holds full-power `DATABASE_URL` unless the operator wires `JEB_DB_URL_REASON`,
  keys.ts:169-174) inserts `standalone=true, post_kind='short', replace_post_id=<valid
  13-char>, content=<non-secret text>, approved_by=NULL`. `publishOne` publishes it under the
  bot key — the scrubber (src/publish.ts:372) and kill switches (337-354) still apply, so
  secrets are gated, but the human-approval control that distinguishes the standalone path is
  silently absent at the signing boundary. The same row with `post_kind='collection'` and a
  valid envelope publishes an unapproved collection.
- **Fix:** select `approved_by` in `claimPublish` and, in `publishOne`, `markPublishFailed`
  any standalone row with null/empty `approved_by` (mirroring the `replace_post_id` refusal at
  src/publish.ts:317-324). Optionally also assert `mention_key` matches the content-seed hash
  for standalone rows.

### F-2 — Low — scripts/post.ts never enforces the proactive kill switch

- **Evidence:** `assertPostPublishAllowed` accepts `proactiveSwitchOn` and its docstring
  promises the standalone writer obeys it (src/post.ts:19-29); the script calls it with only
  `contractMode` (scripts/post.ts:101) and later with `repliesSwitchOn` computed from env+DB
  replies/global switches only (scripts/post.ts:155-166). The publisher does enforce proactive
  for standalone rows (src/publish.ts:340-342, 352-354), so only the direct operator path
  diverges.
- **Exploit path:** during a proactive-switch incident, `npm run post:publish -- --file …`
  still PUTs a standalone post under the bot key.
- **Fix:** compute `proactiveOn = envSwitchOn("proactive") || (await store.switchOn("proactive"))`
  alongside `repliesOn` and pass `proactiveSwitchOn: proactiveOn` at scripts/post.ts:166.

### F-3 — Low — scripts/post.ts --delete bypasses all kill-switch checks

- **Evidence:** the delete branch runs at scripts/post.ts:103-107, before the switch
  computation at 155-166; only `JEB_CONTRACT_MODE` blocks it (101). The header comment
  advertises switch refusal for the tool generally (scripts/post.ts:17-19).
- **Exploit path:** none that harms — deleting the bot's own post during a kill-switch epoch
  is arguably desirable — but the behavior is undocumented and inconsistent with --edit.
- **Fix:** document the exemption in the header comment, or apply the same replies/global
  check for uniformity.

### F-4 — Info — --edit can convert a reply into a standalone post at the same id

- **Evidence:** `--edit <id>` rebuilds via `buildStandalonePost(..., editId)` which emits a
  parent-less post JSON at `/pub/pubky.app/posts/<id>` (src/post.ts:180-188,
  scripts/post.ts:140); nothing warns when `<id>` currently holds a reply. Keyspace
  confinement means no other user's post is reachable (see Threat Q5).
- **Exploit path:** operator footgun only; content still passes `assertOutboundClean`
  (scripts/post.ts:116).
- **Fix:** optional preflight GET of the target path; warn if the existing JSON has `parent`.

### F-5 — Info — NODE_OPTIONS is inherited by the no-key children

- **Evidence:** `SYSTEM_PASS` includes `NODE_OPTIONS` (keys.ts:56) and `pickEnv` copies it
  into both child envs (keys.ts:154-161, used by src/main.ts:44-45). Node honors flags such as
  `--require`, so a polluted parent env loads attacker code into the reason/ingest processes
  (still without key material, but inside the trust perimeter, with DB access).
- **Fix:** drop `NODE_OPTIONS` from `SYSTEM_PASS` unless a deployment needs it; if kept,
  document the tradeoff.

### F-6 — Info — Migration 100's ADD CONSTRAINT is not SQL-idempotent

- **Evidence:** migrations/100_scout_canary.sql:16-18 has no `DROP CONSTRAINT IF EXISTS`
  guard, unlike the `IF [NOT] EXISTS` style used everywhere else in 097–099. The migrator
  applies each id once under an advisory lock (migrator.ts:51-104), so normal fleets are fine;
  a restored/manually-prepared DB that has the constraint but lacks the `migrations` row will
  fail startup (migrator rethrows, migrator.ts:97-100).
- **Fix:** prepend `ALTER TABLE scout_canary DROP CONSTRAINT IF EXISTS scout_canary_outcome_chk;`
  for consistency with the repo's idempotent-migration convention.

### F-7 — Info — 099's column drops are irreversible but verified unused

- **Evidence:** `post_json`/`post_path` added in 097:25-26, dropped in 099:4-5; no reader or
  writer exists in src/ outside those migrations (grep-confirmed); the publisher rebuilds posts
  from `post_kind`/`attachments`/`replace_post_id` (src/publish.ts:389-417). No unique
  constraint or idempotency key is touched by 097–100.
- **Fix:** none. Recorded so the destructive step has an audit trail.

---

### Verified controls (no finding)

- `replace_post_id` shape re-validation at the trust root with loud failure
  (src/publish.ts:313-324) and a path-traversal regression test (src/publish.test.ts:800-825).
- Reply-tag author check (src/reply-tags.ts:146-149); artifact-tag double validation
  (src/reply-tags.ts:178-180; src/publish.ts:161, 180).
- Scrubbed rows publish only the safe constant decline (src/publish.ts:364-370).
- Signup token is consumed and erased from env after signup (src/homeserver.ts:51-52).
- `assertNoKeyMaterial()` at reason startup (src/reason.ts:54, keys.ts:29-37); publish child
  alone keeps full env (src/main.ts:41-46).
- Exactly-once publishing guarded by partial unique index + `ON CONFLICT … DO NOTHING`
  (migration 050:31-33, src/db.ts:505) and supersede semantics for collection upserts
  (src/publish.ts:138, src/db.ts:134-140).

KIMI_AUDIT_A1_COMPLETE
