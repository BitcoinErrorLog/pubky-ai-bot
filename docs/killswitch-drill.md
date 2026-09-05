# Kill-switch drill

Stage 1 gate evidence for:

- **"kill switch drill passed in production"**
- **"Global switch disables all write paths within one minute"**

Named switches also include `proactive` and `weekly` (`ALL_SWITCHES` in
`packages/bot-kit/src/policy/switches.ts`). Both are honoured via `storeSwitchOn` on
their write paths (`proactive` for operator-approved standalone posts; `weekly` for
the Sunday/Monday articles). They are **not** in `DRILL_SWITCHES` — this drill has
no probe observable for either path.

The drill (`scripts/killswitch-drill.ts`, npm script `drill:killswitch`) runs against a
live stack reachable via `DATABASE_URL` and the ingest health port. For each switch in
`[global, replies, generation, consumption, scout, web]` it:

1. records the baseline (`switches` table + `kill_switch`),
2. flips the switch ON through `Store.setSwitch` — the same DB helper the operator
   admin endpoint (`POST /admin/switch/{name}`) uses,
3. polls the observable the running code already exposes and asserts the effect within
   **60 s** (`--deadline-ms`),
4. restores the baseline and asserts recovery within the same 60 s,
5. prints per-switch **time-to-effect** and **time-to-recover**, exit code non-zero on
   any failure.

All switches are restored to baseline on every exit path, including SIGINT/SIGTERM and
uncaught errors. The drill refuses to start when any switch (or `kill_switch`) is
already on — drilling over an existing stop would mask its cause.

## Observables

| Switch | Probe | Effect observable | Recovery observable |
| --- | --- | --- | --- |
| `global` | queued `publish_requests` row | publisher claims the row and refuses the PUT: `last_error = "Error: replies switch on"` | row reaches `published` |
| `replies` | same as `global` | same as `global` | same as `global` |
| `generation` | queued `work_queue` row | row stays `queued`, sampled every 250 ms, for the whole `--suppress-ms` window (default 10 s); a claim while ON is counter-evidence and fails instantly | reason claims the row (status leaves `queued`) |
| `consumption` | ingest `/healthz` | `lastPollAgeMs` exceeds `--poll-stale-ms` (default 10 s) — the poll loop short-circuits before the Nexus fetch, so the age goes stale | `lastPollAgeMs` drops back below half the threshold |
| `scout` | real `recommend_follows` executor, `storeSwitchOn` wired to the live table | tool returns the `SWITCH` refusal | refusal disappears (the probe's scout URL is forced to a closed loopback port, so recovery never touches the real service) |
| `web` | real `search_web` executor, same wiring | tool returns the `SWITCH` refusal | refusal disappears (provider kept `moonshot` — `off` would refuse *before* the switch gate and mask the test — with the base URL forced to a closed loopback port) |

Notes:

- `global` is verified through the publisher write path because `publish_requests` is
  the only path that writes to Pubky; `setSwitch("global", …)` also sets every named
  switch and `kill_switch`, and the per-switch rows cover the other pipelines.
- `generation` has no positive "refused" marker in the schema (the reason loop simply
  skips `claimWork`), so its effect is measured as a suppression window; its
  time-to-effect equals `--suppress-ms` by construction.
- `consumption`/`generation` interact through `kill_switch`: flipping
  `consumption`, `generation`, or `replies` also sets `kill_switch`, which pauses the
  *other* pipelines too. The drill therefore polls each probe's baseline health check
  until the pipeline has recovered from the previous switch's test before flipping
  the next one.
- Probe rows (`bot_id = 'drill'`, synthetic `pubky://drill…` URIs) are deleted after
  each switch, pass or fail.

## Run locally (compose)

The drill needs: the three roles running, `DATABASE_URL` reachable, and the ingest
health endpoint reachable. The compose file does not publish the role health ports,
so either run the drill inside the compose network or publish the port:

```bash
export POSTGRES_PASSWORD=… JEB_BOT_PK=… PUBKY_BOT_SECRET_KEY_HEX=…
docker compose up -d
# ingest needs a health port; override before up, e.g.:
#   JEB_PORT=9000 docker compose up -d   (and publish 127.0.0.1:9000:9000 on ingest)
docker compose exec ingest node dist/scripts/killswitch-drill.js \
  --health-url http://127.0.0.1:9000/healthz
# or from the host, with the port published:
DATABASE_URL=postgres://jeb:$POSTGRES_PASSWORD@127.0.0.1:5432/jeb \
  npm run drill:killswitch -- --health-port 9000
```

Without `--target railway` the drill refuses to run against a non-loopback
`DATABASE_URL` host.

### Local run without Docker (what this machine did)

The Docker daemon is hung on this machine (see README: image build unverified), so
the recorded run below used the same arrangement as the contract harness, natively:

- local Postgres, dedicated `jeb_drill` database;
- a throwaway bot key (`npm run keygen -- --out <file>`), signed up on the **staging**
  homeserver with an admin-minted single-use token (password read via command
  substitution, never echoed) — the two recovery replies were real PUTs from that
  throwaway account, same as contract-harness runs;
- a loopback fixture Nexus (empty notification feed, 404 otherwise) as
  `JEB_NEXUS_URL`;
- `JEB_CONTRACT_MODE=1` (skips embedding warm-up) and `JEB_CANNED_REPLY` so no model
  key is needed;
- `node dist/main.js --role ingest|reason|publish` with `JEB_PORT=9310`,
  `JEB_POLL_MS=500`.

## Run in production (documented only — do not run from this branch)

The production image is built from `tsconfig.build.json`, which has `rootDir: src`
and emits only `src/**` — **the plain build does not emit `scripts/` to `dist/`**.
`tsx` is a devDependency and is pruned from the production image
(`npm prune --omit=dev`), so `npx tsx` is not available there either. The build
therefore includes a dedicated step (`npm run build:drill`, `tsconfig.drill.json`)
that emits `dist/scripts/killswitch-drill.js` (with its own `dist/src/` dependency
closure), and the Dockerfile runs it in the build stage. Production command:

```bash
railway ssh --service jeb -- node dist/scripts/killswitch-drill.js \
  --target railway \
  --health-url "http://127.0.0.1:${JEB_PORT}/healthz"
```

`--target railway` lifts the loopback-`DATABASE_URL` guard and labels the report.
`DATABASE_URL` is already in the service env. Set `JEB_PORT` on the ingest role if
the health endpoint is not enabled. Add `--json` for the machine-readable report,
`--only <switch>` to drill a single switch.

## Expected output

Progress lines go to stderr; the report to stdout:

```
kill-switch drill  target=local  deadline=60000 ms  started=2026-09-04T08:54:22.273Z

switch          time-to-effect   time-to-recover   result
------------ ---------------- ----------------- ------
global                  757 ms           1264 ms     pass
replies                 767 ms           1258 ms     pass
generation            10169 ms            252 ms     pass
consumption           10067 ms            505 ms     pass
scout                     1 ms              3 ms     pass
web                       0 ms              1 ms     pass

drill PASSED (6/6 switches within 60000 ms)
```

Exit code: `0` when every switch passes, `1` on any failure, `2` on usage error or
operator interrupt (switches are still restored).

## When a switch misses its deadline

1. **Read the error line** (`error <switch>: …` under the table) and the failing
   phase: no effect vs no recovery.
2. **No effect** means the switch did not stop the pipeline:
   - `replies`/`global`: the publisher never refused the probe row. Check the publish
     process is alive (`/healthz` on `JEB_PORT+2`), then inspect the probe row —
     if it reached `published` while the switch was on, the replies gate in
     `publishOne`/`tagOne` regressed; treat as a sev and roll back the deploy.
   - `generation`: `work claimed while generation switch on` means reason claimed
     work under the gate; check `generationBlocked()` wiring in `runReason`.
   - `consumption`: polls never went stale — check the ingest process and the
     `store.switchOn("consumption")` check in `pollOnce`.
   - `scout`/`web`: the tool executor did not return the `SWITCH` refusal — check
     `scoutSwitchBlocked`/`webSwitchBlocked` and the `storeSwitchOn` wiring in
     `reasonOne`.
3. **No recovery** means the pipeline did not resume after restore: verify the
   switch rows and `kill_switch` are actually back to baseline
   (`SELECT * FROM switches; SELECT * FROM kill_switch;`), then the role logs.
   Remember `setSwitch(consumption|generation|replies, false)` does **not** clear
   `kill_switch` — the drill clears it explicitly; a manual flip via SQL must too.
4. The drill always restores the baseline before exiting, but confirm it:
   `SELECT name, on_flag FROM switches; SELECT disabled FROM kill_switch;`
5. Leftover probe rows are safe to delete:
   `DELETE FROM publish_requests WHERE mention_key LIKE 'pubky://drill%';`
   (same for `work_queue` and `handled_mentions`).

## Production drill result (paste into the plan gate)

| Field | Value |
| --- | --- |
| Date (UTC) |  |
| Deploy / git SHA |  |
| Command | `railway ssh --service jeb -- node dist/scripts/killswitch-drill.js --target railway --health-url …` |
| global effect / recover |  |
| replies effect / recover |  |
| generation effect / recover |  |
| consumption effect / recover |  |
| scout effect / recover |  |
| web effect / recover |  |
| Verdict |  |
| Operator |  |

## Local run 2026-09-04

Native stack (Docker daemon hung): local Postgres `jeb_drill` DB, fixture Nexus on
loopback, `JEB_CONTRACT_MODE=1` + `JEB_CANNED_REPLY`, throwaway bot key signed up on
the staging homeserver. Command:

```bash
DATABASE_URL=postgres://…@127.0.0.1:5432/jeb_drill \
  npx tsx scripts/killswitch-drill.ts --health-port 9310
```

Output (exit code 0):

```
kill-switch drill  target=local  deadline=60000 ms  started=2026-09-04T08:54:22.273Z

switch          time-to-effect   time-to-recover   result
------------ ---------------- ----------------- ------
global                  757 ms           1264 ms     pass
replies                 767 ms           1258 ms     pass
generation            10169 ms            252 ms     pass
consumption           10067 ms            505 ms     pass
scout                     1 ms              3 ms     pass
web                       0 ms              1 ms     pass

drill PASSED (6/6 switches within 60000 ms)
```

`global` disabled the publisher write path in **757 ms** (gate: within one minute).
Recovery publishes were real PUTs to the staging homeserver from the throwaway key.
After the run: all switch rows off, `kill_switch.disabled = false`, zero leftover
probe rows. The drill DB and key material were destroyed afterwards.

## Production run — 2026-09-04

Executed from the operator machine with `railway ssh --service jeb -- node dist/scripts/killswitch-drill.js --target railway --health-url http://127.0.0.1:8080/healthz` (note: wrapping the command in `sh -c '...'` makes `railway ssh` open a Node REPL instead of running it; pass `node` directly). Result: **PASSED 6/6** within the 60 s deadline. Full log: `killswitch-drill-production-2026-09-04.txt`.

| switch | time-to-effect | time-to-recover |
|---|---|---|
| global | 6075 ms | 6068 ms |
| replies | 5558 ms | 6065 ms |
| generation | 10102 ms | 254 ms |
| consumption | 10088 ms | 2270 ms |
| scout | 6 ms | 14 ms |
| web | 4 ms | 12 ms |

All switches took effect well inside the plan's one-minute requirement (§4.7). Stage 1 gate item "kill switch drill passed in production" is met.
