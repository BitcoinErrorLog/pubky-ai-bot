# Jeb public limits

These are the **code defaults** in `src/config.ts`. Environment variables override them. Operators should treat `.env` as the live source of truth and confirm with `npm run dashboard` (header: effective policy limits). A stale `JEB_MAX_REPLIES_PER_THREAD=1` in production env will cap threads at one reply even though the code default is 12.

| Limit | Env | Default | What it does |
| --- | --- | --- | --- |
| Thread cap | `JEB_MAX_REPLIES_PER_THREAD` | 12 | Maximum Jeb replies (`published` or still `processing`) in one thread (`root_uri`). Further addressed turns are **skipped** (`skip_reason=thread_cap`). |
| Per-user thread turns | `JEB_MAX_TURNS_PER_USER_PER_THREAD` | 6 | Maximum Jeb replies already in the ancestor chain that answered this asker. Further turns are **skipped** (`user_turn_cap`). |
| Per-user hourly cap | `JEB_MAX_PER_USER_PER_HOUR` | 5 | Maximum **published** replies to one author in the last hour. Further mentions are **skipped** (`user_hourly_cap`). |
| Daily token budget | `JEB_DAILY_TOKEN_BUDGET` | 2_000_000 | Global (and per-user) token ceiling for the UTC day. Exceeding it **skips** the mention (`budget`) before a model answer; if a model/tool run hits the budget mid-turn, Jeb **publishes a fallback** (`fallback_reason=budget`) instead of staying silent. |
| Model step timeout | `JEB_MODEL_TIMEOUT_MS` | 30_000 | Per model-call abort. Timeout → **fallback** (`timeout`), not skip. |
| Answer budget | `JEB_ANSWER_BUDGET_MS` | 180_000 | Overall reason-loop wall clock. Exhaustion composes from evidence or **fallback**. |
| Reply deadline | `JEB_REPLY_DEADLINE_MS` | 240_000 | Mentions still unpublished past this window get a guaranteed fallback so a policy-passed mention does not end with zero replies. |
| Poll interval | `JEB_POLL_MS` | 3_000 | Ingest Nexus poll period. |
| Mention age (first boot) | `JEB_MAX_AGE_MINUTES` | 30 | First-boot ingest drops older notifications. |
| Known bots | `JEB_KNOWN_BOTS` | empty | Public keys treated as automated repliers → **skip** `bot_author`. |
| Blocklist | `JEB_BLOCKLIST` | empty | Plus Postgres `blacklist` table → **skip** `blocklist`. |

## Skip vs fallback

**Skip** (`handled_mentions.status=skipped`): Jeb does not reply. Used for policy refusals (thread/user caps, unaddressed, bot loop, blocklist, pre-check budget). `skip_reason` is stored.

**Fallback** (`status=published` with `fallback_reason`): Jeb still posts a short deterministic reply (timeout, model error, tool unavailable, mid-turn budget). History of the mention is not rewritten later.

Kill switches (`JEB_DISABLED`, `JEB_SWITCH_*`, Postgres `switches` / `kill_switch`) pause ingest, generation, replies, scout, or web without changing these numeric caps.
