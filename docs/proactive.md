# Proactive drafts (stage 2)

Jeb may **compose** six standalone formats. Nothing in this stage **publishes** a proactive post unless an operator runs `approve` with `--by <handle>`. Draft formats still have no cron-to-network path. The Sunday/Monday weekly articles are a separate autonomous path (`docs/weekly.md`). A draft format graduates to autonomous publication only after measured accuracy and reception (`drafts stats`), not after a switch flip.

Global default is off (`JEB_DRAFTS_ENABLED` unset/0). Each format is independently off until `JEB_DRAFT_<FORMAT>_ENABLED=1`. Cap: `JEB_PROACTIVE_MAX_PER_DAY` (default **1** approved proactive post per UTC day; any integer ≥ 1 is allowed). That cap is the **single source of truth**, enforced in the approve transaction (`countApprovedProactiveToday` / `approveDraft`) and stored as `drafts.proactive_utc_day`. Because the cap is configurable, concurrent approves are serialized with `pg_advisory_xact_lock(JEB_PROACTIVE_CAP_LOCK)` before the count — not a unique index on `proactive_utc_day` (that would force the cap to 1). Approved, published, and `declined` rows all count against the day. The publisher does not re-check the daily cap.

## CLI

```
npm run drafts -- generate [--format what_changed|thread_worth_reading|the_disagreement|new_connection|pubky_explained|release_radar|all]
npm run drafts -- list [--status draft|approved|rejected|published|declined]
npm run drafts -- show <id>
npm run drafts -- approve <id> --by <handle>
npm run drafts -- reject <id> --by <handle> --reason <text>
npm run drafts -- regenerate <id>
npm run drafts -- render [--all|--id <id>] --out <dir>
npm run drafts -- stats
```

`generate` may be operator-invoked or cron-invoked. Cron only writes `status=draft` rows. Pending drafts are also listed on the loopback admin page `GET /admin/drafts` (same `ADMIN_TOKEN` / bind as the rest of `/admin`); Approve / Reject / Regenerate are CSRF-protected POSTs.

## Switches

| Env | Default | Effect |
| --- | --- | --- |
| `JEB_DRAFTS_ENABLED` | off | Master switch for `generate` |
| `JEB_DRAFT_WHAT_CHANGED_ENABLED` | off | What changed |
| `JEB_DRAFT_THREAD_WORTH_READING_ENABLED` | off | The thread worth reading |
| `JEB_DRAFT_THE_DISAGREEMENT_ENABLED` | off | The disagreement |
| `JEB_DRAFT_NEW_CONNECTION_ENABLED` | off | New connection |
| `JEB_DRAFT_PUBKY_EXPLAINED_ENABLED` | off | Pubky explained |
| `JEB_DRAFT_RELEASE_RADAR_ENABLED` | off | Release radar |
| `JEB_DRAFT_WINDOW_DAYS` | 7 | Lookback for every generator. Filter by real post time (Crockford post id = µs timestamp; else Nexus created_at/indexed_at in s/ms/µs), not Scout's default window. |
| `JEB_GITHUB_TOKEN` | unset | Read-only GitHub token for draft evidence (public repos). Read by the drafts CLI (main process) and by the publish process on admin-page regenerate — never `GITHUB_TOKEN` / `GH_TOKEN`, and not passed to the reason or ingest children. Scope: `public_repo` or fine-grained read-only metadata. Unset → unauthenticated → rate-limit → `none: evidence source unavailable`. Never log. |
| `JEB_PROACTIVE_MAX_PER_DAY` | 1 | Approved proactive posts per UTC day (approve-time only) |
| `JEB_SWITCH_PROACTIVE` / DB switch `proactive` | off | Publisher refuses standalone PUTs while on |
| `JEB_SWITCH_REPLIES` / `JEB_SWITCH_GLOBAL` / `JEB_DISABLED` | off | Publisher also refuses replies and standalone PUTs |

## Formats

Each generator must attach ≥1 evidence URI or it rejects itself (`DraftRejectedError`). Bodies are voice-linted (`lintVoice`, citation cap 8) and capped at 2000 characters. The model may cite only URLs in that evidence set; `finishDraft` drops bullets (and strips inline URLs) that point elsewhere. Claims stay claimant-counted; interpretations are marked as Jeb's.

If the week's evidence is too thin, the generator throws `DraftRejectedError` with a `none: …` reason. `drafts generate` prints `format<TAB>none<TAB>…` and does **not** fail the run. It never invents a changelog, a disagreement, or a thread.

`composeDraftProse` reads the model finish reason. A `length` stop, or a body that does not end on a sentence/bullet boundary, drops the trailing incomplete paragraph. If fewer than two complete bullets remain (list formats) or leftover prose is under ~200 characters, the draft is `none: truncated output`. A markdown-link-only body is retried once with a stricter instruction, then `none: link-only body`. Per-format minimum lengths apply either way.

If GitHub is rate-limited (403/429 or `x-ratelimit-remaining: 0`) the generator returns `none: evidence source unavailable` instead of composing from a partial set. `regenerate` (CLI and admin page) then rejects the existing draft so a previous partial body is not left in place. Authenticated calls use `JEB_GITHUB_TOKEN` only (drafts CLI / publish-process regenerate; public-repo read-only) and follow same-host `api.github.com` 301s (`/repos/{owner}/{repo}` → `/repositories/{id}`); off-host redirects are rejected.

Graph-sourced strings are sanitized at `finishDraft`: labels use the Scout tag whitelist (`[A-Za-z0-9_-]`, max 20); titles and previews have control characters and newlines collapsed, markdown link/image/autolink URLs dropped, and `pubky://` URIs plus bare 52-char pubkeys stripped so `rewritePubkyCitations` cannot promote attacker links. Evidence URIs live on the draft row; they are not prepended onto the body.

### What changed

Diff of the week from the knowledge index (`knowledge_documents.ingested_at` in the window) plus Pubky-ecosystem GitHub commits and releases. If the local index is empty, GitHub commits on allowlisted repos fill in. Output: 3–6 bullets of the form "X changed: what it means", each linked. `none` if nothing material landed.

### The thread worth reading

Scout `top_posts` (`metric: replies`, windowed), then a full Nexus thread (root + replies, full bodies). Candidates are scored by distinct authors, replies, and tags; the model picks the **most substantive** thread, not the busiest. Output: one paragraph on what it is about, 2–4 bullets of actual positions with author/post links, one line on why it is worth reading, and a link to the root. Trivial or single-author threads → `none`.

### The disagreement

Same candidate path as the thread format. A disagreement is **two distinct authors making opposing claims in a reply chain**. Tag-label clusters (`get_debate_map`) are not a source. Output: topic; side A (who, claim, link); side B; evidence each cites; one line on what would settle it. No verdict. `none` if there is no real disagreement.

### New connection

From `get_emerging_topics`, `search_posts` on the rising tag (window-filtered), then `get_relationship` between two authors. Output is one or two sentences with profile and post links — not a tuple dump. `none` when Scout has no emerging topic or fewer than two in-window authors.

### Pubky explained

Picks a question people actually asked this week (mentions of Jeb, tags `ask-pubky` / `pubky-questions`, or high-tag posts that read as a Pubky-concept question). Answers via knowledge retrieval + the model: 3–6 short paragraphs, sources at the end, status labels as inline clauses. Never a raw documentation paste. `none` if no suitable question or the index cannot answer it.

### Release radar

GitHub releases in the window for the Pubky-ecosystem allowlist only (`pubky/*` plus named repos: pubky-app, pubky-ring, pubky-core, pkarr, pubky-nexus, nexus-scout, homegate, paykit/paykit-rs, locks/pubky-locks, loopky, hypercolor, pubky-ai-bot). **bitkit-\* is dropped.** For each release the generator fetches the GitHub body and the model writes one sentence of what changed, grouped by repo. `none` if nothing dated landed — it does not invent a "no releases" draft.

## Approval rule

`approve` is the only path from a draft to the network, and it uses the **same standalone queue as collections/tags**:

1. Operator runs `approve <id> --by <handle>`.
2. After the UTC-day cap check (under the advisory lock), `enqueueStandalonePost` inserts a `publish_requests` row (`standalone=true`, `post_kind` short if body length ≤2000 else long, no attachments, `approved_by`, deterministic `replace_post_id` / `mention_key`). Content is the **locked** draft body from the `FOR UPDATE` row (evidence URIs stay on the draft row). If the enqueue reports `inserted === false`, approve rolls back with `identical content already queued/published as request #N` instead of linking the existing request.
3. The draft is marked `approved` with `decided_by` and `publish_request_id` pointing at that row. A CHECK constraint requires `decided_by` on `approved` / `published` / `declined`.
4. The publisher claims the row, re-checks replies/global/proactive kill switches, runs `validatePublishShape` and the outbound secret scrubber, rebuilds with `buildStandalonePost` + `standalonePostId`, and PUTs.
5. On a successful PUT of the approved content, `markLinkedDraftPublished` sets the linked draft to `published` (same guard as `markDraftPublished`: must already be `approved` with a non-empty `decided_by`). If the outbound gate scrubbed the row and published the decline instead, `markLinkedDraftDeclined` sets status `declined`. Reception stats (`drafts stats`) count only `published` rows that were not scrubbed.

There is no `post_json` / `post_path` column. `scripts/post.ts` is an operator CLI that also calls `buildStandalonePost`; queued bot posts go through `enqueueStandalonePost` only.

## Graduation

A format may be considered for autonomous publication only when, over a measured window:

1. Operator reject rate is low relative to generate+approve.
2. `drafts stats` reception (Nexus post view: replies, reposts, bookmarks, tags) is recorded, not guessed.
3. Sampled factual checks against the attached evidence URIs pass (same standard as replies).
4. An explicit later plan changes this document. Stage 2 does not flip that switch.
