# Jeb knowledge evaluation

Stage 1 week 2 ticket 9. 200-question knowledge set plus retrieval and answer runners. Graph/Scout interaction scenarios are out of this ticket.

## How to run

Use the ingested public corpus. Default eval database is `jeb_eval` so knowledge unit tests that reset `jeb_knowledge_test` do not wipe the gate.

```bash
export JEB_MODEL_CACHE=/Volumes/vibedrive/vibes-dev/pubky-ai-bot-jeb/.cache/jeb-models
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

## Measured retrieval rates

Measured 2026-09-03 on `jeb_eval` (3695 chunks, local `Xenova/bge-small-en-v1.5`). **Overall answerable retrieval: 90.9%** (150/165), gate ≥ 90%. Historical top-status `historical`/`deprecated`: **100%** (5/5).

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
