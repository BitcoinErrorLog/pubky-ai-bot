# Drafts review 2026-09-05b

Live generate against production Nexus/Scout/model (Railway `jeb-staging` env, local `jeb_formats_test` DB). Generate never publishes.

| Format | Result | Reason or file |
| --- | --- | --- |
| what_changed | generated | [0090-what_changed.md](0090-what_changed.md) (1523 chars, 6 complete bullets). [0051-what_changed.md](0051-what_changed.md) is the truncated predecessor from the first live run. |
| thread_worth_reading | none | no substantive thread (model; multi-author candidates existed) |
| the_disagreement | none | no real disagreement (model; reply-chain candidates existed) |
| new_connection | none | need two authors and a post in the window |
| pubky_explained | none | knowledge unavailable for that question (`jeb_formats_test` has no ingested chunks; Railway Postgres is internal-only) |
| release_radar | generated | [0052-release_radar.md](0052-release_radar.md) |

Composition follow-up (same day): truncation / link-only guards in `composeDraftProse`; GitHub 403/429 / `x-ratelimit-remaining: 0` → `none: evidence source unavailable`; `regenerate` rejects the old row on that reason. Unauthenticated GitHub was remaining-0 after the first run; 0090 used `gh` auth so the generator could fetch.
