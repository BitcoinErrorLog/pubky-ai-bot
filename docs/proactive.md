# Proactive drafts (stage 2)

Jeb may **compose** six standalone formats. Nothing in this stage **publishes** a proactive post unless an operator runs `approve` with `--by <handle>`. There is no cron-to-network path. A format graduates to autonomous publication only after measured accuracy and reception (`drafts stats`), not after a switch flip.

Global default is off (`JEB_DRAFTS_ENABLED` unset/0). Each format is independently off until `JEB_DRAFT_<FORMAT>_ENABLED=1`. Cap: `JEB_PROACTIVE_MAX_PER_DAY` (default **1** approved proactive post per UTC day), enforced at approve time and stored as `drafts.proactive_utc_day`.

## CLI

```
node dist/main.js --role drafts generate [--format what_changed|thread_worth_reading|the_disagreement|new_connection|pubky_explained|release_radar|all]
node dist/main.js --role drafts list [--status draft|approved|rejected|published]
node dist/main.js --role drafts show <id>
node dist/main.js --role drafts approve <id> --by <handle>
node dist/main.js --role drafts reject <id> --by <handle> --reason <text>
node dist/main.js --role drafts stats
```

`generate` may be operator-invoked or cron-invoked. Cron only writes `status=draft` rows.

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
| `JEB_PROACTIVE_MAX_PER_DAY` | 1 | Approved proactive posts per UTC day |

## Formats

Each generator must attach ≥1 evidence URI or it rejects itself (`DraftRejectedError`). Bodies are voice-linted (`lintVoice`) and capped at 2000 characters. Claims stay claimant-counted; interpretations are marked as Jeb's.

### What changed

From Scout `get_what_changed` on topic `pubky` (last day). Lists indexed posts and app links.

Example:

> What changed on "pubky" in the last day, from the public graph (claimant posts, not a verdict).
> - https://pubky.app/post/…/… — homeserver session notes
> My read: 4 indexed posts since the cutoff.

### The thread worth reading

From Scout `top_posts` (`metric: replies`) then `scout_get_thread` on the top URI. Counts are evidence, not a verdict.

Example:

> The thread worth reading, by reply count on the public graph…
> https://pubky.app/post/…/…
> Reply count in the window: 12.

### The disagreement

From Scout `get_debate_map`. Sides are tag-label clusters with evidence posts, not a winner.

Example:

> The disagreement on "pubky", from reply chains where participants tagged each other with differing labels.
> - Label "spec" — 3 authors, 5 tag claims. https://pubky.app/post/…

### New connection

From `get_emerging_topics`, `search_posts` on the rising tag, then `get_relationship` between two authors on those posts.

Example:

> New connection around rising tag "pkarr" (distinct-tagger delta, not a social verdict).
> https://pubky.app/profile/… and https://pubky.app/profile/… both appear on recent posts with that tag.

### Pubky explained

From knowledge retrieval (`search_knowledge` / the public index in `docs/knowledge.md`). Mechanism in Jeb's words; source URLs required.

Example:

> Pubky explained, from the public knowledge index…
> Sources: https://pubky.org/Explore/Concepts/Credible Exit.md

### Release radar

GitHub releases (then tags) for **git** entries in `sources.yaml` (the knowledge index: pubky-core, pubky-app-specs, nexus, app, knowledge-base, paykit-rs, pkarr, …). If nothing dated in the last 14 days, the draft **says so** and still cites the releases pages. It does not invent a changelog.

Example (nothing new):

> Release radar: no dated GitHub releases in the last 14 days among indexed git sources…

## Approval rule

`approve` builds a standalone post with `buildStandalonePost` (`kind: long` if `title` is set, else `short`) and inserts a `publish_requests` row with `standalone=true`, `post_json`, `post_path`, `mention_key` = the new post URI (same unique key the reply publisher already understands). Status becomes `approved` with `decided_by`. The publisher hook (not in this change) PUTs `post_json` to `post_path`. `markDraftPublished` only succeeds for `approved` rows with a non-empty `decided_by`.

## Graduation

A format may be considered for autonomous publication only when, over a measured window:

1. Operator reject rate is low relative to generate+approve.
2. `drafts stats` reception (Nexus post view: replies, reposts, bookmarks, tags) is recorded, not guessed.
3. Sampled factual checks against the attached evidence URIs pass (same standard as replies).
4. An explicit later plan changes this document. Stage 2 does not flip that switch.
