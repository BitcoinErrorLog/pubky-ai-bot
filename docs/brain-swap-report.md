# Brain swap report (Pubchi Wave 0)

Worktree `/Volumes/vibedrive/vibes-dev/pubky-ai-bot-brain`, branch `stage4/brain`.
Date: 2026-09-05. Operator constraint: only Moonshot may receive public thread text; the second brain is loopback Ollama, not another cloud vendor.

Identity, policy, tools, fixtures, and prompts were not changed for this proof. The contract adapter still sets `JEB_CANNED_REPLY`, so both A and B exercise ingest → reason → publish through the new `Brain` seam **without** a live generate. `model` phase timings were `0` on every case. Live Moonshot generate is **unverified** (no `JEB_MODEL_API_KEY` in this worktree, the jeb worktree `.env`, or process env). Live Ollama generate was smoked separately for the quality-delta section.

## Exact commands

### Unit + build (isolated DBs; shared `jeb_stage1_test` is polluted by other worktrees)

```bash
cd /Volumes/vibedrive/vibes-dev/pubky-ai-bot-brain
DATABASE_URL=postgres://johncarvalho@127.0.0.1:5432/jeb_brain_test \
JEB_KNOWLEDGE_TEST_DATABASE_URL=postgres://johncarvalho@127.0.0.1:5432/jeb_brain_knowledge_unit \
JEB_EVAL_DATABASE_URL=postgres://johncarvalho@127.0.0.1:5432/jeb_eval \
npm test

npm run build
npm run build:contract
```

### Retrieval / eval gate (no live model)

```bash
cd /Volumes/vibedrive/vibes-dev/pubky-ai-bot-brain
DATABASE_URL=postgres://johncarvalho@127.0.0.1:5432/jeb_eval \
JEB_EVAL_DATABASE_URL=postgres://johncarvalho@127.0.0.1:5432/jeb_eval \
npm run eval:retrieval
```

### Negative egress (required before baselines)

```bash
cd /Volumes/vibedrive/vibes-dev/pubky-ai-bot-brain
JEB_BRAIN=moonshot \
JEB_MODEL_BASE_URL=https://api.openai.com/v1 \
DATABASE_URL=postgres://johncarvalho@127.0.0.1:5432/jeb_brain_test \
npx tsx -e 'import { configFromProcessEnv } from "./src/config.ts"; configFromProcessEnv({ requireSecret: false, role: "reason" });'
```

Literal stdout:

```
brain egress refused: host 'api.openai.com' is not api.moonshot.ai or loopback; set JEB_BRAIN_EGRESS_DANGEROUS=1 to override
```

Unset `JEB_MODEL_BASE_URL` + `JEB_BRAIN=moonshot` starts (default `https://api.moonshot.ai/v1`).

### Contract A — Moonshot (canned; unique run id)

```bash
cd /Volumes/vibedrive/vibes-dev/jeb-contract
env -u PUBKY_BOT_SECRET_KEY_FILE \
JEB_CONTRACT_MODE=1 \
JEB_CONTRACT_RUN_ID=brain-swap-a3-20260905 \
DATABASE_URL=postgres://johncarvalho@127.0.0.1:5432/jeb_brain_contract \
CONTRACT_HOMESERVER=staging \
CONTRACT_STAGING_ADMIN_PASSWORD="$(cat /tmp/jeb-staging-admin.pw)" \
CONTRACT_ADAPTER=/Volumes/vibedrive/vibes-dev/pubky-ai-bot-brain/dist-contract/contract-adapter.js \
JEB_BRAIN=moonshot \
JEB_MODEL=kimi-k3 \
JEB_MODEL_BASE_URL=https://api.moonshot.ai/v1 \
JEB_SWITCH_PROACTIVE=0 \
npx vitest run tests/contract.test.ts
```

Result: **14 passed (14)**. Duration 160.12s. `WALL_SECONDS=162`. Token usage: canned, `model: 0` on every case.

### Contract B — Ollama qwen2.5:7b (canned; unique run id)

```bash
cd /Volumes/vibedrive/vibes-dev/jeb-contract
env -u PUBKY_BOT_SECRET_KEY_FILE \
JEB_CONTRACT_MODE=1 \
JEB_CONTRACT_RUN_ID=brain-swap-b-20260905 \
DATABASE_URL=postgres://johncarvalho@127.0.0.1:5432/jeb_brain_contract \
CONTRACT_HOMESERVER=staging \
CONTRACT_STAGING_ADMIN_PASSWORD="$(cat /tmp/jeb-staging-admin.pw)" \
CONTRACT_ADAPTER=/Volumes/vibedrive/vibes-dev/pubky-ai-bot-brain/dist-contract/contract-adapter.js \
JEB_BRAIN=ollama \
JEB_MODEL=qwen2.5:7b \
JEB_MODEL_BASE_URL=http://127.0.0.1:11434/v1 \
JEB_SWITCH_PROACTIVE=0 \
npx vitest run tests/contract.test.ts
```

Result: **14 passed (14)**. Duration 153.61s. `WALL_SECONDS=155`. Token usage: canned, `model: 0` on every case.

Ollama serve: `OLLAMA_MODELS=/Volumes/vibedrive/vibes-dev/.cache/ollama/models /usr/local/bin/ollama serve` (models dir on vibedrive; `qwen2.5:7b` Q4_K_M, 4.68 GB).

## Per-case table (official A3 vs B)

| Case | A Moonshot | B Ollama |
| --- | --- | --- |
| HAPPY: mention → one valid reply, restart does not duplicate | pass | pass |
| FAILURE: deleted parent 404 → no reply, later mention still answered | pass | pass |
| FAILURE: malformed notification skipped, later mention answered | pass | pass |
| FAILURE: transient Nexus 5xx then success → exactly one reply | pass | pass |
| EDGE: 25-post ancestor chain | pass | pass |
| EDGE: 100 duplicate overlapping notifications → exactly one reply | pass | pass |
| EDGE: self-mention → no reply; later ordinary mention → one reply | pass | pass |
| EDGE: bot-to-bot loop respects maxRepliesPerThread | pass | pass |
| EDGE: modelDelayMs honored | pass | pass |
| FAILURE: crash after successful publish → no second-reply | pass | pass |
| EDGE: start/end boundary re-delivery → one reply | pass | pass |
| EDGE: legacy `pk:` mention prefix | pass | pass |
| EDGE: mention inside kind long post | pass | pass |
| EDGE: mention in a reply whose parent is a repost | pass | pass |

Earlier A runs (same adapter, same canned path) flaked when collection standalone PUTs landed before `waitReplies(1)`:

- A1 (`JEB_CONTRACT_RUN_ID=run`, shared suite bot): 7 failed / 7 passed (HAPPY, deleted-parent, malformed, Nexus 5xx, 25-ancestor, 100 dupes, self-mention).
- A2 (`brain-swap-a-20260905`): 2 failed / 12 passed (HAPPY, deleted-parent). `expectOneValidReply` saw 0 parent hits because `waitReplies` returned collection posts; `expectStableCount(0)` saw leftover listings.

Those failures are **harness / collection-reconcile race**, not the Brain interface and not model quality. The contract was not lowered. Unique `JEB_CONTRACT_RUN_ID` (fresh staging key) plus a quiet listing is what made A3/B green.

## Retrieval gate (unchanged, no live model)

`npm run eval:retrieval` against `jeb_eval`, `WALL_SECONDS=6`:

| Category | Answerable | Hits | Rate |
| --- | --- | --- | --- |
| pubky-architecture-identity | 25 | 24 | 96.0% |
| homeserver-sdk-specs-pkarr-pkdns | 30 | 24 | 80.0% |
| nexus-scout | 25 | 24 | 96.0% |
| pubky-app-ring | 20 | 19 | 95.0% |
| bitkit-blocktank | 15 | 15 | 100.0% |
| paykit-locks-atomicity | 16 | 15 | 93.8% |
| cross-product | 15 | 12 | 80.0% |
| current-vs-historical-traps | 13 | 13 | 100.0% |
| **overall (answerable)** | **159** | **146** | **91.8%** (gate ≥ 90%) |
| historical top-status | 5 | 5 | 100.0% |

## Identity / artifact hashes (unchanged by this wave)

```
add0f08df5262de5ea3db7855e741af401eb069b238929aed0f38069ffd0f89e  content/announcement.json
c6307170f343f45a43f7084b2dc737b5d3e6d141ae702be2c4af839484718e55  src/voice.ts
dd24b5a83eb74e12876769e3d02a255174ecf66853fda5b7e5ef964ef9260a95  src/tools.ts
016b7e3a1a0b6e1d24ce0cce08d7cf197e169abd9a72c952c2f6da9a6dcfb074  docs/voice.md
```

`git diff 48b4a16 HEAD -- content/announcement.json src/voice.ts src/tools.ts docs/voice.md` is empty. Jeb facade `src/tools.ts` is the tool registry; Kit registries were not swapped.

## Quality delta (where B is worse)

The behavioural contract does **not** score answer quality. Both A and B published the harness canned string. Interface swap is proven; live quality is not.

Live Ollama `createJebBrain({ brain: "ollama", model: "qwen2.5:7b", ... }).generate("Reply with one short sentence: what is Pubky?")`:

- `wall_ms=12078`, `tokens=56`, `supportsTools=true`
- text: `Pubky is a platform that helps publishers manage and monetize their content.`

That sentence is wrong (Pubky is a public-key identity / homeserver protocol, not a publisher CMS). Failure class: **model quality**, not the interface. The adapter returned a normal `generate` result; no fallback, no silent switch.

Live Moonshot Kimi K3 generate: **unverified** — `JEB_MODEL_API_KEY` was not present in documented locations. Did not hunt Keychain or disk.

Do not treat B as production-ready for public threads. Operator rule still holds: only Moonshot may receive public thread text.

## Unit / build tails

`npm test` (isolated DBs above):

```
 Test Files  100 passed (100)
      Tests  1134 passed | 3 skipped (1137)
   Duration  70.88s
```

`npm run build`:

```
> pubky-ai-bot@1.1.0 build
> tsc -p tsconfig.build.json && mkdir -p dist/infrastructure/database/migrations dist/scout dist/bot-kit/scout && cp src/infrastructure/database/migrations/*.sql dist/infrastructure/database/migrations/ && cp packages/bot-kit/src/scout/schema.golden.json dist/scout/schema.golden.json && cp packages/bot-kit/src/scout/schema.golden.json dist/bot-kit/scout/schema.golden.json
```

exit 0.

## Unverified

- Live Moonshot `generate` (missing documented API key).
- Contract A/B do not exercise tool-calling or sampling on the live model (`JEB_CANNED_REPLY`).
- First two A runs failed on collection-listing races; official A is A3.
