# Jeb public limits

These are the **code defaults** in `src/config.ts`. Environment variables override them. Operators should treat `.env` as the live source of truth and confirm with `npm run dashboard` (header: effective policy limits). A stale `JEB_MAX_REPLIES_PER_THREAD=1` in production env will cap threads at one reply even though the code default is 12; config load logs a warn when that value is below 4 or when `JEB_DAILY_TOKEN_BUDGET` is below 1_000_000.

| Limit | Env | Default | What it does |
| --- | --- | --- | --- |
| Thread cap | `JEB_MAX_REPLIES_PER_THREAD` | 12 | Maximum Jeb replies (`published` or still `processing`) in one thread (`root_uri`). Further addressed turns are **skipped** (`skip_reason=thread_cap`) and get one public notice unless anti-spam suppresses it. |
| Per-user thread turns | `JEB_MAX_TURNS_PER_USER_PER_THREAD` | 6 | Maximum Jeb replies already in the ancestor chain that answered this asker. Further turns are **skipped** (`user_turn_cap`) with a notice. |
| Per-user hourly cap | `JEB_MAX_PER_USER_PER_HOUR` | 5 | Maximum **published** replies to one author in the last hour. Further mentions are **skipped** (`user_hourly_cap`) with a notice. |
| Daily token budget (global) | `JEB_DAILY_TOKEN_BUDGET` | 5_000_000 | UTC-day global token ceiling. The check adds a typical-answer estimate (p50 of `token_usage.total_tokens` over 7 days, fallback 20_000) before spending. Exceeding it **skips** (`budget`) with a notice. Mid-turn exhaustion still **publishes a fallback** (`fallback_reason=budget`). |
| Daily token budget (per user) | `JEB_USER_DAILY_TOKEN_BUDGET` | 600_000 | Same estimate-before-spend check, per asker public key. |
| Model step timeout | `JEB_MODEL_TIMEOUT_MS` | 30_000 | Per model-call abort. Timeout → **fallback** (`timeout`), not skip. |
| Answer budget | `JEB_ANSWER_BUDGET_MS` | 180_000 | Overall reason-loop wall clock. Exhaustion composes from evidence or **fallback**. |
| Reply deadline | `JEB_REPLY_DEADLINE_MS` | 240_000 | Mentions still unpublished past this window get a guaranteed fallback so a policy-passed mention does not end with zero replies. |
| Tool loop steps | `JEB_TOOL_MAX_STEPS` | 4 | Max model steps that may invoke tools in one answer. |
| Poll interval | `JEB_POLL_MS` | 3_000 | Ingest Nexus poll period. |
| Mention age (first boot) | `JEB_MAX_AGE_MINUTES` | 30 | First-boot ingest drops older notifications. |
| Known bots | `JEB_KNOWN_BOTS` | empty | Public keys treated as automated repliers → **silent skip** `bot_author`. |
| Blocklist | `JEB_BLOCKLIST` | empty | Plus Postgres `blacklist` table → **silent skip** `blocklist`. |

## Skip vs fallback vs notice

**Silent skip** (`handled_mentions.status=skipped`, no publish request): abuse-class only — `blocklist`, `bot_author`, `unaddressed`, `bot_loop`, `self`.

**Notified skip** (`status=processing` until the publisher PUTs, then `published`; `skip_reason` preserved; exactly one `publish_requests` row, category `declined`, evidence `kind=policy_notice`, `fallback_reason` = the skip reason, tokens 0): `budget`, `user_hourly_cap`, `user_turn_cap`, `thread_cap`. A suppressed hit is `skipped` with `notice_suppressed=true` and no publish row.

**Anti-spam:** at most one notice per `(author, skip reason)` in a rolling 6 hours, and at most one notice per thread (`root_uri`) per skip reason. Further hits are silent skips with `notice_suppressed=true`. Suppression is a Postgres query on `evidence` + `handled_mentions`, not process memory.

Notice texts (voice-linted, no model call):

- `budget`: I've used my answer budget for today; it resets at 00:00 UTC. Mention me again after that.
- `user_hourly_cap`: I've answered you a few times this hour; I'll pick up again in a bit.
- `user_turn_cap`: That's my limit for one thread with one person. Start a new post if you want to keep going.
- `thread_cap`: This thread has hit my reply cap. Start a new post and I'll answer there.

**Last-allowed prefix:** when an accepted mention is the final one a quota still permits, Jeb prefixes the reply (model answer or fallback) with one sentence, then `Here's your answer:` on its own line. First matching rule wins; prefixes never stack. The prefix is applied outside the model text and counts toward the 2000-character short-post cap (the answer is trimmed, never the prefix). Evidence stores `quota_notice` = the rule id. Category tags are unchanged.

- `user_daily_budget`: This is my last reply to you today; my budget for you resets at 00:00 UTC (in about {h}h {m}m).
- `global_daily_budget`: This is my last reply for today; my budget resets at 00:00 UTC (in about {h}h {m}m).
- `user_hourly_cap`: This is my last reply to you this hour; I'll pick up again in about {m} minutes.
- `user_turn_cap`: This is my last reply to you in this thread; start a new post if you want to keep going.
- `thread_cap`: This is my last reply in this thread; start a new post and I'll answer there.

**Fallback** (`status=published` or still processing toward publish, `fallback_reason` on the mention): Jeb still posts a short deterministic reply (timeout, model error, tool unavailable, mid-turn budget). A last-allowed quota prefix is kept if policy already decided one. History of the mention is not rewritten later.

Kill switches (`JEB_DISABLED`, `JEB_SWITCH_*`, Postgres `switches` / `kill_switch`) pause ingest, generation, replies, scout, or web without changing these numeric caps.

## User opt-out

Anyone can tell Jeb to stop, permanently, in public: mention Jeb with a first-person opt-out ("stop replying to me", "don't reply to me", "leave me alone", "unsubscribe", "mute me", "opt out", and close variants). Jeb replies once:

`Understood — I won't reply to you again. Mention me with 'you can reply to me again' to undo.`

Later mentions from that key are a **silent skip** (`skip_reason=optout`) — no notice, no model call, no policy-cap notice. Opt-out is stored in `user_optouts` until the same key opts back in ("you can reply to me again", "opt in", "unmute me"); that also gets one confirmation. Repeated opt-out/opt-in requests while already in that state do not get another confirmation.

Confirmations bypass policy caps by design (fixed text, zero model tokens, always a reply to the requester's own mention), but they are **one per actual state transition**: repeats while already in the target state are silent skips, so flapping cannot produce more than one confirm per change.

Opt-outs are public as an aggregate: the dashboard shows a **count**, and `--role optouts` prints the keys for the operator. Jeb never posts other people's pubkys as an opt-out list.

Questions about the mechanism for other people ("how do I stop Jeb replying to others?") are not treated as opt-out.


## Operator: requeue and in-place replace

`--role requeue --mention <uri>` reopens a skipped/failed mention. Add `--replace` to overwrite Jeb's existing reply (same post id) instead of posting a second one. See README "Requeue skipped or failed mentions".

Exception: if the re-answer ends in a **notified policy skip** (blocklist, budget, hourly/turn/thread cap), the previously published answer is NOT overwritten with the skip notice — the notice is posted as a new reply and the old reply stays in place. This is logged at warn with the mention key and skip reason ("requeue --replace ended in a notified skip; leaving the prior reply in place").

The same holds for **opt-out/opt-in confirmations**: a `requeue --replace` of an opt-out mention never overwrites the prior reply with the confirm text (the confirm posts as a new reply, logged at warn as above), and if the key is already in the requested state nothing new is posted at all.
