# Stage 1 merge proof (2026-09-03)

Worktree `pubky-ai-bot-jeb`, branch `stage1/extract`.

## Typecheck / build

`npx tsc --noEmit` — exit 0 (no output).

```
> pubky-ai-bot@1.1.0 build
> tsc -p tsconfig.build.json && mkdir -p dist/infrastructure/database/migrations && cp src/infrastructure/database/migrations/*.sql dist/infrastructure/database/migrations/


> pubky-ai-bot@1.1.0 build:contract
> tsc -p tsconfig.contract.json && mkdir -p dist-contract/infrastructure/database/migrations && cp src/infrastructure/database/migrations/*.sql dist-contract/infrastructure/database/migrations/
```

## Unit tests (isolated DBs)

`DATABASE_URL=…/jeb_stage1_test JEB_KNOWLEDGE_TEST_DATABASE_URL=…/jeb_knowledge_unit JEB_EVAL_DATABASE_URL=…/jeb_eval JEB_MODEL_CACHE=…/.cache/jeb-models npm test`

```
 Test Files  16 passed (16)
      Tests  95 passed | 1 skipped (96)
   Start at  13:38:56
   Duration  8.62s
```

Skipped: `live scout identity` (requires `SCOUT_LIVE=1`).

## Corpus intact

`psql -h 127.0.0.1 -d jeb_eval -tAc "select count(*) from knowledge_chunks"` → `3695`

## Scout live

`SCOUT_LIVE=1 npm test -- src/scout/scout.test.ts`

```
 ✓ src/scout/scout.test.ts (14 tests) 609ms
   ✓ live scout identity (SCOUT_LIVE=1) > search John Carvalho then identity summary shape 532ms
 Test Files  1 passed (1)
      Tests  14 passed (14)
```

One live identity test in this file; the rest are offline guard/stub tests. All 14 passed with `SCOUT_LIVE=1`.

## Contract

`jeb-contract` with `JEB_CONTRACT_MODE=1`, staging homeserver, admin password from `$(cat …)`, `CONTRACT_ADAPTER=…/dist-contract/contract-adapter.js`, `DATABASE_URL=…/jeb_stage1_test`:

```
 Test Files  3 passed (3)
      Tests  19 passed (19)
   Start at  13:39:15
   Duration  113.30s
( time )  19.58s user 3.38s system 20% cpu 1:53.76 total
```

## LOC

`wc -l $(ls src/*.ts src/**/*.ts | rg -v '\.test\.ts$') | tail -1` → `8169 total`
