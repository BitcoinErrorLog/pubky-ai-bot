# Stage 0 modernization report

Date: 2026-09-03  
Repo: `/Volumes/vibedrive/vibes-dev/pubky-ai-bot`  
Branch: `stage0/modernize` (from `main`)  
No remotes written.

## What changed

Surgical updates so this bot typechecks, speaks Pubky SDK 0.6.0 / specs 0.4.4, polls Nexus with a timestamp cursor, fail-closes on Redis errors, honors a kill switch and daily token budget, actually starts in production (`tsc-alias` + `node dist/server.js`), and implements `src/contract-adapter.ts` for jeb-contract.

Contract follow-up (jeb-contract `3428ea0`): the fake `fallback-http` homeserver is gone. Modes are `pubky-testnet` (`Pubky.testnet()`) and `staging` (`new Pubky()`). The adapter and `src/services/pubky.ts` publish only via `session.storage.putJson`. No `x-pubky-user`, `JEB_CONTRACT_RUNTIME`, or `fallbackUrl` remains.

Also required for a green contract run:

- Config loads from the package `config/` directory (`__dirname`), not `process.cwd()` (the harness cwd is `jeb-contract`).
- Validation throws instead of `process.exit(1)` so vitest is not killed.
- `MentionPoller.stop()` no longer hangs when the idle `setTimeout` is cleared (that blocked HAPPY restart).
- Adapter `start()` isolates Postgres/Redis **once per instance**. Mid-test `stop()`/`start()` keeps cursor and idempotency so a restart does not double-reply.

Deleted: `src/services/factcheck.ts`, `src/services/mcp/client.ts`, `Dockerfile.brave-mcp`, unused Redis subscriber, unused histogram timer helpers, `start.js`.

## Proof commands

### `npx tsc --noEmit`

**Pass** (exit 0).

### `npm run build`

**Pass** (exit 0). Emits `dist/contract-adapter.js` with rewritten `@/` imports.

### `REDIS_URL=redis://127.0.0.1:6379/3 npm test`

**Pass.** 5 suites, 60 tests, 133.289 s.

Redis: Homebrew on `127.0.0.1:6379`, DB index 3.

### Contract (`jeb-contract` × compiled adapter, staging)

```bash
cd /Volumes/vibedrive/vibes-dev/jeb-contract
CONTRACT_HOMESERVER=staging \
CONTRACT_STAGING_ADMIN_PASSWORD="$(cat /tmp/jeb-staging-admin.pw)" \
DATABASE_URL=postgres://johncarvalho@127.0.0.1:5432/jeb_bot_test \
REDIS_URL=redis://127.0.0.1:6379/3 \
CONTRACT_ADAPTER=/Volumes/vibedrive/vibes-dev/pubky-ai-bot/dist/contract-adapter.js \
npm test
```

**Pass.** 3 files, **19/19 tests**, 173.72 s (behavioral file 172.597 s).

| Case | Result | Time |
| --- | --- | --- |
| HAPPY mention + restart no duplicate | pass | 12.4 s |
| Deleted parent 404, later mention answered | pass | 13.4 s |
| Malformed notification skipped | pass | 9.6 s |
| Transient Nexus 5xx then one reply | pass | 14.1 s |
| 25-post ancestor chain + created_at order | pass | 4.3 s |
| 100 duplicate notifications → one reply | pass | 10.1 s |
| Self-mention skipped | pass | 10.1 s |
| Bot-to-bot loop / maxRepliesPerThread | pass | 10.1 s |
| modelDelayMs + later mention in budget | pass | 7.2 s |
| Crash after publish, restart, later mention | pass | 14.6 s |
| start/end re-delivery | pass | 13.1 s |
| Legacy `pk:` prefix | pass | 4.9 s |
| kind long | pass | 5.0 s |
| Reply-to-repost then ordinary mention | pass | 8.7 s |
| Fixture shape (4) + process-group (1) | pass | <1 s |

Postgres: Homebrew 17 at `127.0.0.1:5432`, database `jeb_bot_test`.  
Admin password was read only via command substitution; never echoed.

### `docker build --target production`

**Skipped.** Docker daemon is hung. No image, no `docker run` dummy-env check. Recorded as blocked on the daemon, not on the Dockerfile.

Expected when the daemon works: build succeeds; `docker run` with dummy mnemonic/DB/Redis fails on config/startup (not `MODULE_NOT_FOUND`), exit non-zero. Production `CMD` is `["node", "dist/server.js"]`. `.dockerignore` is present.

### Kill-switch drill

Bot running against the contract fixture Nexus (staging homeserver for publish). Redis DB 3 key `jeb:kill_switch`. Adapter poll interval 1 s; armed wait 2500 ms (two poll intervals + margin).

| Step | Result |
| --- | --- |
| `SET jeb:kill_switch 1`, enqueue mention, wait 2551 ms | **0 posts** (`okBlocked: true`) |
| `DEL jeb:kill_switch` | reply appeared in **3241 ms** (`okReplied: true`, 1 post) |
| Total after start | 5794 ms |

Poller skips consume while the key is `1`; `publishReply` also refuses PUT. `POST /api/admin/kill` and `/resume` require `x-admin-token` == `ADMIN_TOKEN` (403 if unset).

## `git diff --stat main`

Mode-bit-only files (100644→100755) show as `0` and were not staged.

```
38 files changed, 1102 insertions(+), 2122 deletions(-)
```

That is the staged content vs `main`: SDK/Nexus/poller/adapter/kill-switch/config/README work, deletions of `factcheck.ts`, MCP client, `start.js`, `Dockerfile.brave-mcp`, plus new `src/contract-adapter.ts`, `src/services/kill-switch.ts`, `006_polling_cursor.sql`, `.dockerignore`, and this report.

## Deliberately left alone

- Classifier / secure-prompts (audit: replace later, not Stage 0).
- Factcheck **worker** + `factcheck-websearch.ts` (still wired).
- `npm audit` / handlebars CVE tree.
- ESLint still has no config (`npm run lint` remains dead).
- Compose default target is still `development`.
- Newest SDK 0.11.0 / specs 0.7.0 (pinned to pubky-app’s 0.6.0 / 0.4.4).
- Injection-detector content previews still log.
- Docker production image proof (daemon hung).

## Redis Streams vs complexity

For this Stage 0 the streams machinery was mostly **cost**. The contract’s value is “poll Nexus, publish one valid post.” A single-process in-memory queue plus Postgres idempotency (what the reference adapter does) would have passed every behavioral case.

What streams **did** earn:

- Crash-mid-handler reclaim (`XAUTOCLAIM` on subscribe) so a pending `XREADGROUP` entry is not stranded after `stop()`/`start()`.
- DLQ only after `maxAttempts`, not on the first throw.

What they **did not** earn:

- A separate Redis subscriber client (deleted).
- Unused histogram timers (deleted).
- `WORKER_TYPE` processes (never existed).
- Per-test isolation pain: consumer groups + `FLUSHDB` + module cache resets exist because the bot is a long-lived process with singleton Redis/Postgres, not because the protocol needs streams.

Honest take: keep the streams only if you intend to run multiple worker processes against the same Redis. For “one Node process answers mentions,” they are an inherited operating cost, not a Stage 0 win. The contract went green **in spite of** that machinery (canned path skips the LLM; the hop through `mention.received` → router → `action.summary.requested` → worker is extra latency, not extra correctness).

## Honest assessment

This codebase can speak current Nexus/SDK shapes and pass the external 19-test staging contract without a rewrite. It is worth evolving **only if** the next stages delete or isolate the streams/classifier/factcheck surface rather than growing it. Stage 0 proved the poll-and-publish core; it did not prove the Redis Streams design is justified.
