# Weekly articles and feedback

Two autonomous article series (no approval step; the operator asked for that) plus a feedback skill that feeds the Sunday post.

The reason role runs the scheduler. `--role all` starts reason, so the loop is live in production. Kill switch: `weekly` (`JEB_SWITCH_WEEKLY=1` or `POST /admin/switch/weekly`). Master flag: `JEB_WEEKLY_ENABLED` (default on; set `0` to disable compose and the loop).

## Schedule

Timezone: `JEB_WEEKLY_TZ` (default `Europe/London`). Fire hour: 09:00 local.

| Day | Series | Title | Week key |
| --- | --- | --- | --- |
| Sunday 09:00+ | `feedback` | Community feedback, week of \<Monday of that ISO week\> | ISO week containing that Sunday. Window: 7 days ending at Sunday 09:00 in `JEB_WEEKLY_TZ`. |
| Monday 09:00+ | `updates` | Pubky weekly, \<Monday of that ISO week\> | that ISO week, Monday 00:00 → Sunday 23:59:59 in `JEB_WEEKLY_TZ`. |

Catch-up: if the process was down at 09:00, the next tick on the **same weekday** after 09:00 still fires. Monday does not publish a missed Sunday. Idempotency is `(series, week_key)` in `weekly_posts` — never twice for the same week.

Zero feedback rows → log and write `status=skipped`. No post.

## Feedback skill

On every mention the reason path processes (after ancestor assembly, never awaited on the answer), a cheap model call classifies the incoming post into zero or more of: `advice`, `complaint`, `feature_request`, `bug_report`, `praise`. Hits go in `feedback_items` (`source=classifier`). Failure is logged and ignored; the reply is unchanged.

Once an hour the same loop collects posts tagged `pubky-feedback`, `ask-pubky`, or `pubky-questions` from Nexus (last 8 days, skip Jeb). Those rows use `source=tag`. Nexus stream-by-tag only honours the first tag, so each label is queried separately.

`quote` is ≤280 characters and is run through tool-output screening plus the draft sanitizer plus instruction-phrase stripping before it is stored. Quoted text cannot carry instructions into the Monday/Sunday model or article body.

## Sunday article

Every `feedback_items` row from the last 7 days that is not yet `included_in_post_uri`, grouped as Advice / Complaints / Feature requests / Bugs / Praise / Tagged questions and feedback. Each line is a short quote, a `pk:` profile link, and a post link (same `pubky.app` render as replies).

"What Jeb changed this week" is included only when `corrections` has rows in that window.

Published as a long article (`enqueueStandalonePost`, `approvedBy=weekly`) with self-tags `community-feedback` and `pubky-weekly`. Included rows get `included_in_post_uri`.

## Monday article

Tracked projects live in `tracked_projects` (seeded: Pubky App, Pubky Ring, Pubky Core / homeserver, Pkarr, Nexus, Nexus Scout, Homegate, Paykit, Locks, Loopky, Hypercolor, Jeb, Pubky Bot Kit). `pubky_ids` for Jeb is the production key `9o6xrx8wgqu48dmb47uep6w3dgbwdnf5jgw83gbeuxg9yi7x444y` (README / pubky-app-specs). Jeb's own posts are excluded as sources; mentions of and replies to that key count. No other official project social pubkys were verified in the knowledge base.

Candidates come from Nexus tag search, author streams (not Jeb's own), Scout `mentions_of` / Nexus notifications for project pubkys, and Scout `search_posts` when the scout switch is off. Each hit is fetched from the Nexus post endpoint and kept only if its timestamp (post-id Crockford µs, else `created_at`/`indexed_at`) is in the week window, content is not deleted, the author is not Jeb, and the post's tags, full body (whole-word name/alias), author, or mentioned pubkys actually name the project. A cheap relevance judgement then drops remaining mismatches before the summariser sees the full body (≤2,000 chars) plus tags/author/timestamp/counts. Bullets that say the source does not mention the project are dropped. Projects with nothing confirmed are one line: `No public updates this week: …`.

A capitalised name that co-occurs with pubky/homeserver/pkarr/pkdns at least 3 times from at least 2 authors, and is not a tracked alias, is inserted as `status=candidate` and listed under "New on the radar". Promote it with the projects CLI.

Self-tags: `pubky-weekly` plus each project tag that had a section.

Model spend is recorded as `phase=weekly` against the global daily budget, with a per-article cap `JEB_WEEKLY_TOKEN_CAP` (default 400_000). Bodies go through the secret scrubber and voice linter like every other publish.

## CLI

```
npm start -- --role weekly run feedback|updates [--week YYYY-Www] [--dry-run]
npm start -- --role projects list
npm start -- --role projects promote <id>
npm start -- --role projects add --name <name> [--id <id>] [--aliases a,b] [--tags t] [--pubky pk]
npm start -- --role projects remove <id>
```

`--dry-run` prints Markdown and does not enqueue, migrate, collect-write, or claim a week slot. Nexus and Scout calls stay read-only. `--week` selects that ISO week. With no `--week`, the CLI renders the issue that would fire next (on Saturday that is this ISO week for both series, not the last completed week).

## Tables

- `feedback_items(id, post_uri unique, author_pk, kinds, quote, detected_at, week_key, source, included_in_post_uri)`
- `weekly_posts(series, week_key, post_uri, mention_key, status, tags)` — primary key `(series, week_key)`
- `tracked_projects(id, name, aliases, tags, pubky_ids, status)`

## Add a project

1. `npm start -- --role projects add --name "Example" --tags example --aliases ExampleApp`
2. Or promote a candidate: `npm start -- --role projects promote example`
3. Optional `--pubky` only for a verified 52-character public key.

## Disable

- `JEB_WEEKLY_ENABLED=0` — loop and CLI refuse to compose.
- `JEB_SWITCH_WEEKLY=1` or admin switch `weekly` — loop skips; publisher refuses `approved_by=weekly` PUTs. Dry-run still prints.
- `JEB_SWITCH_GLOBAL=1` / `JEB_DISABLED=1` — same as every other write path.
