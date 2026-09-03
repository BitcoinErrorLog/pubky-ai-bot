# Jeb public knowledge index

Stage 1 week 2 ticket 8. Corpus is public-only. Internal strategy documents, annual reports, budgets, and `.cursor/plans` are refused at ingest (path logged, contents never stored).

## Layout

- `sources.yaml` — versioned manifest
- `src/knowledge/` — gate, chunker, embedders, hybrid retrieval, evidence rows
- `scripts/ingest.ts` — `npm run ingest -- [--source id] [--full]`
- `src/infrastructure/database/migrations/020_knowledge.sql` — `vector` + `pg_trgm`
- Tool: `search_knowledge` in `src/tools.ts`, wired in `src/answer.ts` with citation rules from plan §4.3

Embeddings default to **local** `Xenova/bge-small-en-v1.5` (384-d) via `@huggingface/transformers` on CPU. Cache: `JEB_MODEL_CACHE` (repo `.cache/jeb-models`, gitignored). First download is about **141 MiB**. OpenAI-compatible: `JEB_EMBED_PROVIDER=openai-compatible` plus `JEB_EMBED_MODEL`, `JEB_EMBED_API_KEY`, `JEB_EMBED_BASE_URL`. Mixing dimensions is an error.

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

`npx tsc --noEmit` and `npm test` (including `tests/knowledge/knowledge.test.ts`) passed after this change.
