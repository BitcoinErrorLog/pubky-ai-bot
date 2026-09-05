# Publishing the announcement article (operator)

Parent-only. Do not run these from CI. Kill switches must be off (`JEB_SWITCH_REPLIES`, `JEB_SWITCH_GLOBAL`, `JEB_DISABLED`). Do not run under `JEB_CONTRACT_MODE=1`. Key loading is the publisher path (`src/keys.ts`); never print key material.

The live profile link title stays **How I work**; it points at this announcement post.

Regenerate the article from code before every publish:

```bash
cd /Volumes/vibedrive/vibes-dev/pubky-ai-bot-dashboard
npm run announcement
npm run content:check
```

Dry-run first (no network, key optional):

```bash
npm run post:publish -- --dry-run --kind long --file content/announcement.json
```

## (a) Publish the announcement article

```bash
npm run post:publish -- --kind long --file content/announcement.json
```

The command prints the `pubky://<bot>/pub/pubky.app/posts/<ID>` URI and the pubky.app post URL. Copy the `pubky://` URI (or the https post URL) into `JEB_HOW_I_WORK_POST_URI`. Do not commit the live URI if it is environment-specific.

## (b) Edit the article in place later

Use the 13-character post id from the URI (`HOWWORK000001` in the example below):

```bash
npm run announcement
npm run content:check
npm run post:publish -- --kind long --file content/announcement.json --edit HOWWORK000001
```

`--edit` overwrites the same URI. Existing attachments are dropped unless you pass `--keep-attachment <file uri>` for each one to keep.

## (c) Republish the profile with the How I work link

The profile bio already includes the compact tag vocabulary. The How I work link is omitted unless a URI is provided. Requesting the link without a URI fails.

```bash
# dry-run
JEB_SOURCE_URL='https://github.com/BitcoinErrorLog/pubky-ai-bot' \
JEB_HOW_I_WORK_POST_URI='pubky://<botpk>/pub/pubky.app/posts/<ID>' \
  npm run profile:publish -- --dry-run --how-i-work "$JEB_HOW_I_WORK_POST_URI"

# live PUT
JEB_SOURCE_URL='https://github.com/BitcoinErrorLog/pubky-ai-bot' \
JEB_HOW_I_WORK_POST_URI='pubky://<botpk>/pub/pubky.app/posts/<ID>' \
  npm run profile:publish -- --how-i-work "$JEB_HOW_I_WORK_POST_URI"
```

`JEB_POLICY_URL` is accepted as an alias of `JEB_HOW_I_WORK_POST_URI`. Optional `--image ./avatar.png` is unchanged.

Replies/global switches must stay off for the PUT; the script refuses if they are on.

## Open tag vocabulary

Self-tags on Jeb's replies and artifact tags on other posts are an **open
vocabulary**. The model proposes labels; the only hard constraints are:

- style: lowercase `[a-z0-9-]`, at most 3 hyphenated words, at most 32
  characters (effective max is `pubky-app-specs` `tagLabelMaxLength`,
  currently 20)
- max 5 tags per post
- denylist: persons' names/handles/pubky ids, slurs, anything the secret
  scrubber flags
- prefer an existing Nexus hot/prefix-search tag when it means the same thing

There is **no operator-approval gate** for self-tags, or for artifact tags
on a post Jeb already answered. Those artifact rows still carry a nonempty
`approved_by` (sentinel `jeb-answered`) so the Kimi A5 F-1 check stays
closed: a blank `approved_by` is failed at the publisher and never PUT.
The publisher accepts the auto sentinel **only** when `handled_mentions`
shows a published reply by Jeb on that URI (`botRepliedTo`). Operator
approval is still required for artifact tags on posts Jeb did not interact
with.

```bash
npm start -- --role tags apply <postUri> <label> --by <handle>
npm start -- --role tags list
npm start -- --role tags revoke <postUri> <label> --by <handle>
```

`approved_by` is required at enqueue **and** re-checked at the publisher
signing boundary (`applyArtifactTagOne`). A row with null/blank
`approved_by` is failed and never PUT. SQL enforces
`CHECK (btrim(approved_by) <> '')` (migration 102).

Revoke is last-writer-wins: it marks the approval row `revoked` **first**,
then DELETEs the homeserver tag (bot keyspace). A publisher PUT that
already claimed the row (`publishing`) cannot resurrect it —
`markArtifactTagDone` only succeeds while status is `publishing`, and
`markArtifactTagRetry` / `markArtifactTagFailed` refuse `revoked` rows. A
lost race DELETEs the just-PUT tag and keeps `revoked`. Revoke of an
already-published tag is the normal case. Revoke without an approval row is
refused (no `--force`); apply the tag first, then revoke. Exhausted
`retry`/`publishing` artifact rows are reaped to `failed` each publisher
tick (`failExhaustedArtifactTags`), matching `failExhaustedPublishes`.

A kit `applyTags` call that includes a transport may PUT an artifact tag
while leaving the row `queued`. Finalization is the claiming publisher's
job; Jeb's CLI apply path does not pass a transport.

## Weekly articles (autonomous)

Sunday community-feedback and Monday pubky-weekly posts are long articles enqueued
by the reason-role scheduler (`approved_by=weekly`). There is no approval CLI for
those two series. See `docs/weekly.md`.

```bash
npm start -- --role weekly run feedback --dry-run
npm start -- --role weekly run updates --dry-run
npm start -- --role weekly run feedback --week 2026-W36
```

`--dry-run` prints Markdown only. A live run claims `weekly_posts(series, week_key)`
and enqueues via `enqueueStandalonePost`. The `weekly` kill switch refuses the PUT.
Do not republish a week by deleting the slot unless you intend a second article.

Published weekly articles carry self-tags `pubky-weekly` and, for Sunday,
`community-feedback`. The publisher's collections hook appends those posts
by tag rule (see below).

## Collections (Jeb-owned)

Jeb maintains public collections under his key: **Jeb's Blog** (every
Article/long post), **Pubky Weekly**, **Community Feedback**, **Pubky
Explained**, **Release Radar**, and one collection per tracked project.
Membership is `collection_rules(collection_key, match: {series?, self_tag?})`.
A published post carrying self-tag `pubky-weekly` lands in Pubky Weekly; a
post tagged `loopky` lands in Loopky. No code coupling to weekly series —
rules match tags alone.

The publisher appends after a successful standalone (non-collection) PUT.
Appends are idempotent. Kill switch `collections` (`JEB_SWITCH_COLLECTIONS`
or the DB switch) blocks reconcile, append, rebuild, and collection PUTs.

```bash
npm start -- --role collections list
npm start -- --role collections show <key>
npm start -- --role collections rebuild <key>
```

`rebuild` re-derives membership from `published` rows and the rule, then
enqueues an upsert.

## Drafts review

Pending drafts are listed on the loopback admin page `GET /admin/drafts`
(same bind and `ADMIN_TOKEN` as the rest of `/admin`). Approve / Reject /
Regenerate are POST-only, CSRF-protected, and call the same functions as
`npm run drafts`.

```bash
npm run drafts -- generate
npm run drafts -- list
npm run drafts -- render --all --out docs/drafts-review-YYYY-MM-DD/
npm run drafts -- approve <id> --by <handle>
```
