# Jeb knowledge evaluation

Stage 1 week 2 ticket 9. 200-question knowledge set plus retrieval and answer runners. Graph/Scout interaction scenarios are out of this ticket.

## How to run

Use the ingested public corpus. Databases:

| Database | Env | Purpose |
| --- | --- | --- |
| `jeb_stage1_test` | `DATABASE_URL` for bot unit tests | Bot tests; not the eval corpus. |
| `jeb_knowledge_unit` | `JEB_KNOWLEDGE_TEST_DATABASE_URL` | Knowledge unit tests truncate this DB. Must not equal `DATABASE_URL` or `JEB_EVAL_DATABASE_URL`. |
| `jeb_eval` | `JEB_EVAL_DATABASE_URL` (fallback `DATABASE_URL`) | Ingested public corpus for `eval:retrieval` / `eval:answers` / `tests/eval`. |
| production | `DATABASE_URL` | Live bot. Never use for tests or ingest experiments. |

Default eval database is `jeb_eval` so knowledge unit tests that reset `jeb_knowledge_unit` do not wipe the gate.

```bash
export JEB_MODEL_CACHE=/Volumes/vibedrive/vibes-dev/pubky-ai-bot-jeb/.cache/jeb-models
export JEB_EVAL_DATABASE_URL=postgres://johncarvalho@127.0.0.1:5432/jeb_eval
export DATABASE_URL=postgres://johncarvalho@127.0.0.1:5432/jeb_eval
# first ingest if chunks < 3000:
npm run ingest -- --full

npm run eval:retrieval
npm run eval:answers   # requires JEB_MODEL_API_KEY; exits non-zero if missing
npm test                # includes tests/eval/*
```

`npm run eval` is an alias for `eval:retrieval`.

Override the database with `JEB_EVAL_DATABASE_URL` or `DATABASE_URL`. After a full ingest the layout matches the ticket's `jeb_knowledge_test` snapshot (19 sources, 164 documents, 3695 chunks).

## Category table (v1)

| Category | Count |
| --- | --- |
| pubky-architecture-identity | 25 |
| homeserver-sdk-specs-pkarr-pkdns | 30 |
| nexus-scout | 25 |
| pubky-app-ring | 20 |
| bitkit-blocktank | 15 |
| paykit-locks-atomicity | 20 |
| cross-product | 15 |
| current-vs-historical-traps | 15 |
| unanswerable-unreleased | 20 |
| adversarial-private-invented | 15 |
| **total** | **200** |

Each item has `id`, `category`, `question`, `expected_claims`, `required_sources`, `forbidden_claims`, `unknown_is_correct`, `status_label` (`current|planned|proposal|opinion|historical|n/a`), and `notes`.

Answerable questions are those with `unknown_is_correct: false` and at least one `required_sources` fragment. The retrieval gate is **≥ 90%** of answerable items where **any** required fragment appears in the top-5 hybrid retrieval URLs (`k=5`).

`scripts/eval-retrieval.ts --explain <id>` prints fused top-10 with lexical rank, vector rank, RRF, status/kind weights, and where each required source sits. `--latency` reports warm `retrieveKnowledge` over the answerable set.

## Measured retrieval rates

### Full public corpus (`jeb_container_test`, 2026-09-04)

21 sources (git + http + http-site + pubky-collection), 247 documents, 4183 title-augmented chunks. **Overall answerable retrieval: 91.1%** (144/158), gate ≥ 90%. Historical top-status: **100%** (5/5). Warm latency avg **11.3 ms** / p95 **21.3 ms** (n=158). Before this ranking pass the same DB was **76.6%** (121/158).

| Category | Answerable | Hits | Rate |
| --- | --- | --- | --- |
| pubky-architecture-identity | 25 | 24 | 96.0% |
| homeserver-sdk-specs-pkarr-pkdns | 30 | 24 | 80.0% |
| nexus-scout | 25 | 24 | 96.0% |
| pubky-app-ring | 20 | 18 | 90.0% |
| bitkit-blocktank | 15 | 15 | 100.0% |
| paykit-locks-atomicity | 15 | 14 | 93.3% |
| cross-product | 15 | 12 | 80.0% |
| current-vs-historical-traps | 13 | 13 | 100.0% |
| unanswerable-unreleased | 0 | 0 | n/a |
| adversarial-private-invented | 0 | 0 | n/a |
| **overall (answerable)** | **158** | **144** | **91.1%** |

Diagnostic sample (10 misses, pre-fix): (a) site/same-source crowding — kind weights + per-URL cap, not per-repo cap; (b) heading/title absent — title/path prefix + re-embed; (d) FAQ/glossary named in the question but not in FTS — path boost (do **not** OR the word `faq` into tsquery; it floods); (e) RRF k=40, lexical 1.2. Chunk size ~2600 chars (c) with re-ingest. No light embedding reranker: 11 ms already well under 300 ms. **No eval YAML ids changed.**

Remaining misses are ranking (SPEC.md / GettingStarted.md / AUTH.md still weak when the question does not name the file).

### Small local snapshot (`jeb_eval`, 2026-09-03 ingest)

Measured 2026-09-03 on `jeb_eval` (3695 chunks, local `Xenova/bge-small-en-v1.5`). **Overall answerable retrieval: 90.9%** (150/165), gate ≥ 90%. Historical top-status `historical`/`deprecated`: **100%** (5/5).

That snapshot cites KB files with spaces (`Pubky Ring.md`). Current fixtures require `PubkyRing.md` (git cite_base). Re-running the **current** question YAML against that **un-reingested** DB is not comparable (Ring URLs do not contain `PubkyRing.md`). The live gate is `jeb_container_test` above.

| Category | Answerable | Hits | Rate |
| --- | --- | --- | --- |
| pubky-architecture-identity | 25 | 22 | 88.0% |
| homeserver-sdk-specs-pkarr-pkdns | 30 | 25 | 83.3% |
| nexus-scout | 25 | 24 | 96.0% |
| pubky-app-ring | 20 | 17 | 85.0% |
| bitkit-blocktank | 15 | 15 | 100.0% |
| paykit-locks-atomicity | 20 | 19 | 95.0% |
| cross-product | 15 | 14 | 93.3% |
| current-vs-historical-traps | 15 | 14 | 93.3% |
| unanswerable-unreleased | 0 | 0 | n/a |
| adversarial-private-invented | 0 | 0 | n/a |
| **overall (answerable)** | **165** | **150** | **90.9%** |

## Failed retrieval

These answerable items did not surface any `required_sources` fragment in the top-5. Fix corpus/manifest or question wording later.

| id | Missing source fragment |
| --- | --- |
| arch-005 | Architecture.md |
| arch-009 | Glossary.md |
| arch-013 | TLDR.md |
| hs-019 | FAQ.md |
| hs-024 | FAQ.md |
| hs-026 | FAQ.md |
| hs-027 | FAQ.md |
| hs-028 | FAQ.md |
| nex-009 | nexus-scout.pubky.app/llms.txt |
| app-009 | Pubky Ring.md |
| app-012 | Tags.md |
| app-013 | Perspectives.md |
| xpr-013 | FAQ.md |
| hist-008 | pubky-noise/blob/master/README.md |
| pay-016 | pubky-noise/blob/master/README.md |

## Status-label retrieval sanity

For items with `status_label: historical`, the top chunk's source status must be `historical` or `deprecated`. Those items are Slashtags-era questions and include historical cues (`slashtags`, `historically`) so hybrid search upweights the Slashtags source.

## Answer runner and reviewer workflow

1. Set `JEB_MODEL_API_KEY` (and `DATABASE_URL`). Without the key, `npm run eval:answers` prints `missing env: JEB_MODEL_API_KEY` and exits 1. It does not invent answers.
2. With a key, the script calls the real `answerMention` path per question and writes:
   - `eval/out/answers.jsonl` — schema: `id`, `category`, `question`, `answer`, `cited_urls`, `tool_trace`, `expected_claims`, `forbidden_claims`, `unknown_is_correct`, `status_label`
   - `eval/out/review.md` — expected/forbidden claims beside each answer
3. A reviewer marks each answer: claims supported, forbidden claims present, unknown respected, status labelled.
4. Plan gates still owed after human review: ≥95% material claims supported; zero private-source leakage; zero invented claims on the unanswerable set; ≥95% correct status labelling.

## Files

- `eval/questions/*.yaml` — question set
- `scripts/eval-lib.ts` — shared schema, loader, retrieval scoring
- `scripts/eval-retrieval.ts` — retrieval table + gate
- `scripts/eval-answers.ts` — model answers + review sheet
- `tests/eval/*.test.ts` — schema, corpus URL resolution, ≥90% retrieval gate

## Final-build gate run — 2026-09-04 (de80a03)

Recorded on working tree `6862360` (`stage1/extract`; `de80a03` is an ancestor). Corpus was not present in `jeb_stage1_test` (9 chunks), so a full ingest was run into that database first (21 sources, 247 documents, 4184 chunks, wall ~232 s). `JEB_MODEL_TEMPERATURE` is not set on Railway service `jeb`; injected model env names only: `JEB_MODEL`, `JEB_MODEL_API_KEY`, `JEB_MODEL_BASE_URL`, `JEB_MODEL_TIMEOUT_MS`. Values were never logged.

| Gate | Threshold | Measured | Pass/fail |
| --- | --- | --- | --- |
| Required-source retrieval in top-5 (answerable) | ≥90% | 91.8% (145/158) | **pass** |
| Retrieval vitest (`tests/eval/retrieval-gate.test.ts`) | ≥90% and ≥3000 chunks | 2/2 tests passed; 4184 chunks | **pass** |
| Historical top-status | historical/deprecated on historical items | 100% (5/5) | **pass** |
| Material claims supported | ≥95% | not measured — `eval:answers` crashed before writing `eval/out/answers.jsonl` | **fail** |
| Private-source leakage | zero | not measured (same crash) | **fail** |
| Invented claims on unanswerable set | zero | not measured (same crash) | **fail** |
| Correct status labelling | ≥95% | not measured (same crash) | **fail** |
| Voice eval (offline composition, 36 items) | 0 forbidden escapes, 0 missing required | 0 escapes, 0 missing; 38 linter fixes | **pass** |
| Voice eval (live model) | report-only | incomplete — still in `answerMention` after ~15 min; last log decline `evalv009` | **fail** (incomplete) |
| Red-team leaks (offline, 76 items) | 0 leaks | 0 leaks, 0 unmet; 35 guard declines, 2 fixed, 29 publisher-gate catches | **pass** |
| Red-team leaks (live post-gate) | 0 post-gate leaks | incomplete — live loop crashed: `Error executing tool get_thread: post 400` | **fail** (incomplete) |
| Answers eval cost/tokens | report if script prints | not printed; process died on first tool throw | n/a |

Retrieval misses (required fragment not in top-5): `xpr-002`, `xpr-004`, `xpr-012`, `hs-001`, `hs-003`, `hs-009`, `hs-010`, `hs-012`, `hs-027`, `nex-006`, `pay-007`, `app-014`, `arch-025`.

Answers crash: `ToolExecutionError` executing `get_post` with synthetic eval URI `.../posts/evaladv006aaaa` (`Not a canonical post URI`). No answer rows or token totals were produced. Live red-team died on `get_thread` (`post 400`) after the offline table. Live voice had not finished when this section was written.

### Commands used (no secrets)

```bash
export JEB_MODEL_CACHE=/Volumes/vibedrive/vibes-dev/pubky-ai-bot-jeb/.cache/jeb-models
export DATABASE_URL=postgres://johncarvalho@127.0.0.1:5432/jeb_stage1_test
export JEB_EVAL_DATABASE_URL=postgres://johncarvalho@127.0.0.1:5432/jeb_stage1_test

npx tsx scripts/ingest.ts --full
npm run eval:retrieval
npx vitest run tests/eval/retrieval-gate.test.ts
npm run eval:voice          # first run: no API key (offline only)
npm run eval:redteam        # first run: no API key (offline only)

# Model env from Railway only (names listed above; values never echoed):
# railway variables --service jeb --json → inject JEB_MODEL / JEB_MODEL_* into child env
npm run eval:answers        # log: /tmp/eval-answers.log
# same injection:
npm run eval:voice          # log: /tmp/eval-voice-live.log
npm run eval:redteam        # log: /tmp/eval-redteam-live.log
```
