# Jeb public knowledge index

Stage 1 week 2 ticket 8. Corpus is public-only. Internal strategy documents, annual reports, budgets, and `.cursor/plans` are refused at ingest (path logged, contents never stored).

## Layout

- `sources.yaml` — versioned manifest (`git`, `http`, `http-site`, `pubky-collection`, disabled `local`)
- `src/knowledge/` — gate, chunker, embedders, hybrid retrieval, evidence rows
- `scripts/ingest.ts` — `npm run ingest -- [--source id] [--full]`
- `src/infrastructure/database/migrations/020_knowledge.sql` — `vector` + `pg_trgm`
- Tool: `search_knowledge` in `src/tools.ts`, wired in `src/answer.ts` with citation rules from plan §4.3

`kind: pubky-collection` fetches a collection post from Nexus (`GET {nexus}/v0/post/{author}/{id}`, host-pinned), then each `kind: long` item. Citations are app links (`https://pubky.app/post/{author}/{id}`), not `pubky://`. Removed collection items are deleted on `--full`.

`kind: http-site` crawls `location` on the same host, respects robots.txt, caps `max_pages` (default 60), 30 s / 2 MiB per page, optional `allow_paths` globs. HTML is reduced to headings and paragraphs.

Embeddings default to **local** `Xenova/bge-small-en-v1.5` (384-d) via `@huggingface/transformers` on CPU. Cache: `JEB_MODEL_CACHE` (repo `.cache/jeb-models`, gitignored). First download is about **141 MiB**. OpenAI-compatible: `JEB_EMBED_PROVIDER=openai-compatible` plus `JEB_EMBED_MODEL`, `JEB_EMBED_API_KEY`, `JEB_EMBED_BASE_URL`. Mixing dimensions is an error.

## Databases

| Database | Env | Purpose |
| --- | --- | --- |
| `jeb_stage1_test` | `DATABASE_URL` in bot unit tests | Bot / Scout / DB tests. Not truncated by knowledge tests. |
| `jeb_knowledge_unit` | `JEB_KNOWLEDGE_TEST_DATABASE_URL` (default `postgres://johncarvalho@127.0.0.1:5432/jeb_knowledge_unit`) | Knowledge unit tests (`tests/knowledge/**`). These tests **truncate** knowledge tables. They refuse to run if this URL equals `DATABASE_URL` or `JEB_EVAL_DATABASE_URL`. |
| `jeb_eval` | `JEB_EVAL_DATABASE_URL` (fallback `DATABASE_URL`) | Ingested public corpus for retrieval/answer eval. Do not point knowledge tests here. |
| production | `DATABASE_URL` | Live bot. Never use for tests. |

Create the knowledge unit database once: `/opt/homebrew/opt/postgresql@17/bin/createdb jeb_knowledge_unit`.

Ingest and eval still take `DATABASE_URL` (or `JEB_EVAL_DATABASE_URL` for eval). Historical proof below used `jeb_knowledge_test`; the eval corpus now lives in `jeb_eval`.

## Proof ingest (`jeb_knowledge_test`, 2026-09-03)

Command: `DATABASE_URL=postgres://johncarvalho@127.0.0.1:5432/jeb_knowledge_test npm run ingest -- --full`

| Metric | Value |
| --- | --- |
| Wall time | 105169 ms (~105 s) |
| Sources processed | 19 |
| Documents | 164 |
| Chunks | 3695 |
| Refused this run | 1 |
| Refusal rule | `internal-strategy-document` (path only: `Synonym/articles/pubky/rise-of-the-robots.md`) |
| Database size | 47437491 bytes (~45 MiB) |

Slashtags is included as a **historical** HTTP source: `https://raw.githubusercontent.com/synonymdev/slashtags/master/README.md`.

## Sample retrieval (top-3 source URLs)

1. **how does a pubky reply reference its parent** — `https://pubky.org/index.md`; `https://pubky.org/Explore/Pubky Core/API.md`; `https://github.com/pubky/pubky-app-specs/blob/master/SPEC.md`
2. **what ports does the static testnet use** — `https://pubky.org/Explore/Technologies/Pubky Docker.md`; `https://pubky.org/Explore/Technologies/Jeb - Pubky AI Bot.md`; `https://github.com/pubky/paykit-rs/blob/master/docs/TESTNET_SETUP.md`
3. **what is credible exit** — `https://pubky.org/Explore/Concepts/Credible Exit.md` (two chunks); `https://github.com/BitcoinErrorLog/pubky-locks/blob/master/readme.md`
4. **is Slashtags still used** — `https://raw.githubusercontent.com/synonymdev/slashtags/master/README.md` (historical, two chunks); `https://raw.githubusercontent.com/pubky/nexus-scout/master/examples.md`
5. **what does Nexus Scout return on /v1/query** — `https://nexus-scout.pubky.app/llms.txt`; `https://raw.githubusercontent.com/pubky/nexus-scout/master/SKILL.md`; `https://raw.githubusercontent.com/pubky/nexus-scout/master/README.md`
6. **what is a pubky homeserver session** — `https://github.com/pubky/pubky-core/blob/master/docs/GETTING_STARTED.md`; `https://pubky.org/FAQ.md`; `https://pubky.org/Troubleshooting.md`
7. **how do tags work in pubky-app-specs** — `https://pubky.org/Explore/Pubky App/Introduction.md`; `https://github.com/pubky/pubky-app-specs/blob/master/SPEC.md`; `https://pubky.org/Glossary.md`
8. **what is Atomicity sealed blob** — `https://github.com/atomicity-credit/atomicity-core/blob/master/README.md`; `https://pubky.org/Explore/Technologies/Pubky Noise.md`
9. **what is Paykit payment discovery** — `https://pubky.org/Explore/Technologies/Paykit.md`; `https://pubky.org/index.md`; `https://github.com/pubky/paykit-rs/blob/master/docs/PAYKIT_PROTOCOL_V0.md`
10. **what is pkarr used for** — `https://pubky.org/Troubleshooting.md`; `https://github.com/pubky/pkarr/blob/master/README.md`; `https://pubky.org/Explore/Pubky Core/Pkarr/0.Introduction.md`

## Container-mode ingest (`jeb_container_test`, 2026-09-03)

Command: `JEB_SOURCES_SKIP_LOCAL=1 DATABASE_URL=postgres://johncarvalho@127.0.0.1:5432/jeb_container_test npm run ingest -- --full`

| Metric | Value |
| --- | --- |
| Wall time | 165594 ms (~166 s) |
| Sources processed | 21 |
| Documents | 247 |
| Chunks | 4059 |
| Refused this run | 2 (`confidential-marker`) |
| Database size | 33068723 bytes (~32 MiB) |

Per source (docs / chunks): bitkit-core-docs 1/20; bitkit-to-site 6/164; nexus-scout-* 4 sources / 28 chunks; paykit-rs-docs 28/1000; pkarr-docs 5/87; pubky-app-docs 16/265; pubky-app-site 1/1; pubky-app-specs 3/44; pubky-core-docs 15/177; pubky-knowledge-base 71/1205; pubky-locks-docs 1/65; pubky-nexus-docs 4/94; pubky-noise-docs 10/216; pubky-org-site 60/465; pubky-ring-docs 1/21; slashtags-historical 1/11; synonym-articles-collection 13/178; synonym-to-site 7/18.

## Retrieval ranking

Hybrid search (`websearch_to_tsquery` + pgvector cosine → RRF k=40, lexical weight 1.2) then multiplies **status**, **kind** (git/http/local ≫ http-site and pubky-collection), and a **path boost** when the question names the document leaf (`FAQ`, `Glossary`, `PubkyRing`, …). Markdown chunks store `filename` + heading path + body; document hashes use `index-v2-title` so re-ingest re-embeds. Alias OR-expansion covers homeserver, pkarr/pkdns, z32, and WoT. Cap one hit per URL and at most two site-crawl hits.

`scripts/eval-retrieval.ts --explain <id>` prints top-10 lexical/vector/RRF/status/kind and where required sources rank. `--latency` averages warm retrieval over answerable questions.

Re-measured 2026-09-04 on `jeb_container_test` after title-augmented re-ingest (21 sources, 247 docs, 4183 chunks): **91.1%** answerable top-5 (144/158), every category ≥ 80%, historical top-status 100% (5/5). Warm `search_knowledge` **11.3 ms** average (n=158). The previous site-inflated run was 76.6%. No eval YAML fixtures were changed.
