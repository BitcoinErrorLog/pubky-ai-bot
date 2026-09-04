# Pubky Bot Kit extraction map (from Jeb)

Source tree: `pubky-ai-bot-jeb` branch `stage1/extract`. Sibling contract: `/Volumes/vibedrive/vibes-dev/jeb-contract`. Imports taken from `^import ` on production `src/**/*.ts` (excluding `*.test.ts`). Tagky: `ls /Volumes/vibedrive/vibes-dev` has no `tagky*` directory.

Rule applied throughout: Kit has no feature Jeb does not use. Jeb is the first consumer (`packages/jeb`).

---

## 1. Module inventory

Classification:

- **Kit-generic** — used by any Pubky bot; Jeb-specific strings/vocab must be injected, not baked in.
- **Jeb-specific** — product identity, drafts formats, knowledge corpus, eval questions, operator CLIs.
- **Mixed** — generic mechanism with hard-wired Jeb text, `JEB_*` env, or Jeb vocab.

Import lists are local `./` / `../` modules only (node/npm omitted). Cycles called out at the end of this section.

### `src/` root

| File | Class | Reason | Local imports |
| --- | --- | --- | --- |
| `types.ts` | Kit | Notification/post URI/cursor helpers; also copies `ContractEnv` from jeb-contract | `log` |
| `log.ts` | Kit | pino logger | — |
| `http.ts` | Kit | SSRF-safe fetch, no redirect, 1MB cap | — |
| `concurrency.ts` | Kit | `Semaphore` | — |
| `shutdown.ts` | Kit | grace + `StoppingError` | — |
| `base32.ts` | Kit | z-base32 for scrubber | — |
| `text-normalize.ts` | Kit | scan normalize | — |
| `auth-error.ts` | Kit | homeserver auth classification | — |
| `nexus-schema.ts` | Kit | Zod for Nexus REST bodies | — |
| `nexus.ts` | Kit | typed Nexus REST client | `http`, `nexus-schema`, `types` |
| `tools.ts` | Kit | `nexusTools`, re-exports Scout/web | `types`, `nexus`, `scout/tools`, `web/tools` |
| `ingest.ts` | Kit | timestamp cursor + `handled_mentions` claim | `config`, `db`, `health`, `log`, `metrics`, `nexus`, `keys`, `switches`, `types`, `shutdown` |
| `policy.ts` | Kit | fail-closed rate/blocklist/thread/opt-out | `db`, `log`, `types` |
| `switches.ts` | Kit | named kill switches (env names still `JEB_SWITCH_*`) | — |
| `health.ts` | Kit | `/healthz`, `/metrics`, admin switch listener | `db`, `metrics`, `switches` |
| `metrics.ts` | Kit | prom-client | — |
| `model.ts` | Kit | OpenAI-compatible `generateText` + delay | `config` |
| `injection-detector.ts` | Kit | instruction-pattern sanitize | `log` |
| `secret-scrub.ts` | Kit | mnemonic/key/hex/z32 scrub | `bip39`, `base32`, `text-normalize` |
| `tool-screen.ts` | Kit | untrusted tool-result screen | `injection-detector`, `secret-scrub` |
| `post.ts` | Kit | PubkyAppPost / collection builders | `upload`, `pubky-app-specs` |
| `upload.ts` | Kit | blob PUT plan + outbound assert | `outbound-gate` |
| `homeserver.ts` | Kit | `Transport`, signup/signin, PUT posts | `auth-error`, `log`, `post`, `types` |
| `keys.ts` | Kit | secret load + process allowlists | `bip39` |
| `keygen.ts` | Kit | keypair CLI | (homeserver/key material) |
| `scout/*` | Kit (except `evidence.ts` voice) | typed Cypher tools + guard | see subdirectory |
| `web/*` | Kit | Brave/Moonshot `search_web` (Jeb uses it) | `config`, `http`, `model`, `switches` |
| `infrastructure/database/migrator.ts` | Kit | SQL migrator runner | `log` |
| `context.ts` | Mixed | generic clip/walk; prompt says “You are Jeb” | `injection-detector`, `secret-scrub`, `types` |
| `compose.ts` | Mixed | compose/lint pipeline; system prompt is Jeb | `modes`, `links`, `voice` |
| `voice.ts` | Mixed | mechanical lint; rules from `docs/voice.md` (Jeb) | — |
| `links.ts` | Mixed | URI rewrite; default `https://pubky.app`, env `JEB_APP_URL` | — |
| `intent.ts` | Mixed | generic tool catalog; regexes + `explain_pubky` + decline copy | — |
| `answer.ts` | Mixed | tool loop + model; Jeb addenda and knowledge/Scout wiring | `compose`, `context`, `fallback`, `intent`, `modes`, `knowledge/*`, `scout/evidence`, `extraction-guard`, `tools`, `tool-screen`, `model`, `metrics` |
| `reason.ts` | Mixed | work-queue consumer; Jeb policy notices + embeddings warmup | `config`, `context`, `concurrency`, `db`, `health`, `injection-detector`, `keys`, `answer`, `fallback`, `model`, `nexus`, `reply-tags`, `policy`, `optout`, `skip-notice`, `switches`, `knowledge/embed`, `policy-summary`, `quota-notice`, `types` |
| `publish.ts` | Mixed | publish gateway + Jeb self-tags/artifact/drafts enqueue | `types`, `db`, `config`, `homeserver`, `health`, `log`, `metrics`, `switches`, `auth-error`, `reply-tags`, `outbound-gate`, `secret-scrub`, `shutdown`, `post` |
| `db.ts` | Mixed | queue/cursor/switches + Jeb drafts/knowledge helpers | `migrator`, `switches`, `drafts/types` |
| `config.ts` | Mixed | Zod env; all keys `JEB_*` / `PUBKY_BOT_*` | `keys`, `log`, `secret-scrub` |
| `outbound-gate.ts` | Mixed | last-line scrub; imports Jeb `systemPrompt` | `compose`, `extraction-guard`, `secret-scrub`, `text-normalize` |
| `extraction-guard.ts` | Mixed | pre-model decline; Jeb infra/prompt leakage rules | `secret-scrub`, `text-normalize` |
| `reply-tags.ts` | Mixed | generic tag PUT; vocab is Jeb (`pubky`/`bitkit`/`paykit`) | `homeserver`, `intent`, `shutdown`, `types` |
| `policy-summary.ts` | Mixed | log dump of limits | — |
| `optout.ts` | Mixed | opt-out phrases + voice-linted confirm | `db`, `log`, `voice` |
| `skip-notice.ts` | Mixed | notified-skip copy + voice | `db`, `log`, `policy`, `voice` |
| `quota-notice.ts` | Mixed | quota sentence + voice | `voice` |
| `fallback.ts` | Mixed | timeout/error fallback replies | `compose`, `db`, `log`, `quota-notice`, `voice` |
| `requeue.ts` | Mixed | operator requeue | `config`, `db`, `nexus`, `types` |
| `metrics-db.ts` | Mixed | token USD + Scout tool names from `intent.SCOUT_TOOLS` | `intent` |
| `modes.ts` | Mixed | `deep`/`sources` parse from mention text | — |
| `profile.ts` | Mixed | profile image CLI | `upload` |
| `nexus-account.ts` | Mixed | dashboard account snapshot | `nexus` |
| `contract-adapter.ts` | Jeb | jeb-contract `BotAdapter` spawning three roles | `db`, `homeserver`, `keys`, `contract-guard`, `types` |
| `contract-guard.ts` | Kit | fixture-Nexus URL guard for contract runs | — |
| `main.ts` | Jeb | `--role` supervisor | `config`, `db`, `ingest`, `publish`, `reason`, `homeserver`, `keys`, `knowledge/run-ingest`, `requeue`, `collections`, `tags` |
| `collections.ts` | Jeb | operator collection CLI | `db`, `config`, `log`, `post`, `publish` |
| `tags.ts` | Jeb | operator artifact-tag CLI | `db`, `config`, `homeserver`, `log`, `publish`, `types` |
| `collections`/`drafts/*` | Jeb | proactive formats, human approve | see subdirectory |
| `corrections.ts` | Jeb | correction YAML writer | `types` |
| `cost-bounds.ts` | Jeb | cost bound tables | `skip-notice`, `metrics-db` |
| `dashboard-report.ts` | Jeb | dashboard HTML/text | `policy-summary`, `reporting` |
| `reporting.ts` | Jeb | dashboard SQL facts | `nexus-account`, `switches` |
| `redteam.ts` | Jeb | redteam YAML runner | `compose`, `extraction-guard`, `injection-detector`, `modes`, `outbound-gate`, `secret-scrub` |

### `src/scout/`

| File | Class | Reason | Local imports |
| --- | --- | --- | --- |
| `types.ts` | Kit | `EvidenceMeta`, `ScoutEnvelope`, `Claim` | — |
| `client.ts` | Kit | `GET /v1/schema`, `POST /v1/query` | `config`, `http`, `types`, `circuit` |
| `guard.ts` | Kit | `guardRawCypher` | — |
| `templates.ts` | Kit | parametrised Cypher | `types` |
| `tools.ts` | Kit | `createScoutTools` | `config`, `log`, `types`, `client`, `budget`, `guard`, `templates`, `types` |
| `budget.ts` | Kit | fail-closed Scout/raw caps | `config`, `switches`, `client`, `circuit` |
| `circuit.ts` | Kit | breaker | `log` |
| `stub.ts` | Kit | fixture Scout HTTP | — |
| `measure.ts` | Kit | live latency script | `db`, `config`, `client`, `tools` |
| `evidence.ts` | Mixed | formats Scout payloads; “Mark interpretations as Jeb's” | — |

`ScoutClient.schema()` (`client.ts:80–84`) is **not** called from `answer.ts` / `intent.ts`. Schema-aware planning is not implemented; golden copy is `src/scout/schema.golden.json`.

### `src/knowledge/`

Jeb uses RAG, so Kit may ship the **mechanism**. Corpus, `sources.yaml`, and “Jeb's” prompt stay in `packages/jeb`.

| File | Class | Reason | Local imports |
| --- | --- | --- | --- |
| `types.ts`, `chunker.ts`, `glob.ts`, `html.ts`, `robots.ts`, `bounded-body.ts`, `http-site.ts`, `embed.ts`, `query.ts`, `store.ts`, `retrieve.ts`, `gate.ts`, `manifest.ts` | Kit | ingest/retrieve/pgvector | as named |
| `tool.ts` | Mixed | `search_knowledge` tool; imports `tools.searchKnowledgeParameters` | `tools`, `embed`, `evidence`, `retrieve`, `store` |
| `evidence.ts` | Kit | persist chunk scores per mention | `store`, `types` |
| `prompt.ts` | Jeb | “Machine inferences are Jeb's” | — |
| `ingest.ts`, `run-ingest.ts`, `pubky-collection.ts`, `index.ts` | Mixed | ingest pipeline + Nexus collection loader | `http`, `nexus-schema`, `types`, `injection-detector` |

### `src/drafts/` — all **Jeb-specific**

Formats (`pubky-explained`, `release-radar`, `the-disagreement`, …), `approveDraftToPublishRequest`, `no-autonomous.ts`. Imports: `db`, `publish.enqueueStandalonePost`, `voice`, `links`, `http`, `types`.

### `src/web/` — **Kit**

`search_web` is in `FULL_TOOLS` (`intent.ts:116`) and `answer.ts` registers it. Keep.

### Scripts / eval (not `src/`, still extraction-relevant)

| Path | Class |
| --- | --- |
| `scripts/eval-*.ts`, `scripts/eval-lib.ts`, `eval/` | Jeb knowledge/voice/redteam harness (separate from jeb-contract) |
| `scripts/ingest.ts` | Jeb corpus ingest |
| `scripts/killswitch-drill.ts` | Kit-shaped drill; JEB env |
| `scripts/post.ts`, `profile.ts`, `correct.ts`, `dashboard.ts`, `cost-bounds.ts` | Jeb operator |

### Cycles

No circular `import` among implementation files. Near-cycles (one-way, do not invert):

1. `db.ts` → type-only `drafts/types` ; `drafts/*` → `db.Store`. Keep drafts out of Kit `Store`.
2. `knowledge/tool.ts` → `tools.ts` (`searchKnowledgeParameters`); `tools.ts` does not import knowledge.
3. `outbound-gate.ts` → `compose.ts`; `compose.ts` does not import outbound-gate.
4. `metrics-db.ts` → `intent.ts` (`SCOUT_TOOLS`); do not reverse.
5. `reply-tags.ts` → `intent.SCOUT_TOOLS`; `publish.ts` → `reply-tags`. One way.

`types.ts` ↔ `log.ts`: `types` imports `log` only for URI/author mismatch warn (`types.ts:83–86`). Fine.

---

## 2. Proposed package layout and public API

```
packages/bot-kit/src/
  ingest/          ingest.ts, types (Notification, mentionKey, cursor)
  context/         context.ts minus Jeb prompt strings
  nexus/           nexus.ts, nexus-schema.ts, tools.ts (nexusTools only)
  scout/           scout/* except Jeb sentences in evidence.ts
  publish/         publish.ts (gateway), post.ts, homeserver.ts, upload.ts
  policy/          policy.ts, switches.ts, health.ts (admin)
  evidence/        Scout EvidenceMeta + knowledge persist shape
  security/        secret-scrub, extraction-guard (inject rules), outbound-gate, keys, auth-error
  queue/           Store subset: cursor, work, publish_requests, switches
  eval/            (see §4 — lives in generalised jeb-contract)

packages/jeb/
  src/compose, voice, intent (regex + copy), answer wiring, reason notices,
  drafts/, knowledge corpus+prompt, reply-tag vocab, contract-adapter, main
```

### 2.1 Public API (signatures as they exist today)

**Ingest / cursor**

```ts
// ingest.ts:12
export async function runIngest(cfg: Config): Promise<() => Promise<void>>
// ingest.ts:89
export function maxProcessedTs(args: {
  items: Notification[]; kept: Notification[]; processed: boolean[];
  lastTs: number; firstBootDone: boolean;
}): number
// ingest.ts:113
export async function ingestOne(store: Store, botPk: string, n: Notification, workStaleMs?: number): Promise<boolean>
// types.ts:91
export function mentionKey(n: Notification): { key: string; kind: MentionKind; author: string; parentUri?: string } | null
// types.ts:138
export function skipStaleFirstBoot(items: Notification[], nowMs: number, maxAgeMinutes: number): Notification[]
// db.ts:78
async getCursor(botId: string, nexusUrl: string): Promise<{ lastTs: number; firstBootDone: boolean }>
// db.ts:89
async setCursor(botId: string, nexusUrl: string, lastTs: number, firstBootDone: boolean): Promise<void>
```

Exactly-once: `handled_mentions` unique claim inside `ingestOne`; cursor F-11 (`ingest.ts:51–61`, `maxProcessedTs`).

**Thread assembler**

```ts
// context.ts:41
export function assemblePrompt(botPk: string, mention: ChainPost, chain: ChainPost[], detector?: InjectionDetector): string
// context.ts:68
export function asChainPost(view: PostView, user?: UserDetails | null): ChainPost
// nexus.ts:94
export async function walkAncestors(nexus: Nexus, leaf: PostView, max?: number): Promise<{ chain: PostView[]; unresolvedParent: boolean }>
```

**Nexus REST tools** (`tools.ts:33` `nexusTools(nexus)`): `get_post`, `get_thread`, `get_user`, `get_user_tags`, `search_posts_by_tag`, `get_post_replies`. Each execute returns `{ …, provenance: "nexus" }`.

Nexus methods: `notifications`, `post`, `user`, `userDetails`, `userTags`, `postReplies`, `searchPostsByTag` (`nexus.ts:15–91`).

**Scout tools**

```ts
// scout/tools.ts:214
export function createScoutTools(opts: {
  cfg: Config; pool: pg.Pool; mentionKey?: string; author?: string;
  storeSwitchOn: () => Promise<boolean>; client?: ScoutClient;
})
// scout/guard.ts:189
export function guardRawCypher(
  cypher: string, params: Record<string, unknown>,
  opts: { limitMax: number; profilePropMax: number; rawEnabled: boolean },
): GuardResult
// scout/client.ts:80
async schema(): Promise<unknown>
// scout/client.ts:86
async query(opts: { cypher: string; params?: Record<string, unknown>; limit?: number; tool: string; mentionKey?: string }): Promise<{ envelope: ScoutEnvelope; cost: QueryCost }>
```

`query_graph` (`scout/tools.ts:796–825`): `raw: true` budget path; requires `cfg.scoutRawEnabled`.

**Publish gateway**

```ts
// db.ts:548 — the PublishRequest row
async insertPublishRequest(row: {
  mentionKey: string; parentUri: string; content: string; evidenceId: number | null;
  failFirstAttempt?: boolean; categories?: string[]; replacePostId?: string | null;
  standalone?: boolean; postKind?: "short" | "long" | "collection" | null;
  attachments?: string[] | null; collectionId?: string | null; approvedBy?: string | null;
  client?: Queryable;
}): Promise<boolean>  // ON CONFLICT mention_key WHERE status IN queued|retry|publishing|published DO NOTHING
// publish.ts:38
export function validatePublishShape(row: { mention_key: string; parent_uri: string; content: string; standalone?: boolean }): void
// homeserver.ts:40
export async function signinOrSignup(signer, opts, botPk, resolveHomeserver?): Promise<Session>
```

Kill switches: `replies` / `global` / `proactive` via `envSwitchOn` + `store.switchOn` (`publish.ts:52–57`). Key only in publish process (`keys.assertNoKeyMaterial` on ingest/reason; `main.ts:41–46`).

**Policy** (`policy.ts`):

```ts
export function authorBlocked(author: string, botPk: string, blocklist: Set<string>): "self" | "blocklist" | null
export function threadCapped(publishedInThread: number, cap: number): boolean
export function userHourCapped(count: number, limit: number): boolean
export function userTurnCapped(turnsWithAsker: number, cap: number): boolean
export function botRepliesInChain(chain: Array<{ author: string }>, botPk: string): number
export function isAddressedTurn(args: { botPk: string; content: string; mentioned?: string[] | null; ... }): boolean
```

Fail-closed: missing DB / switch on / budget check throwing skip (`reason.ts` skip path + Scout `checkScoutBudgets`).

**Evidence**

- Scout: `EvidenceMeta` (`scout/types.ts:44–54`) `{ provenance: "scout"; tool; truncated; notes; scope }`.
- Knowledge persist: `persistKnowledgeEvidence(pool, mentionKey, result)` (`knowledge/evidence.ts:5`).
- Answer `AnswerResult` (`answer.ts:69`): `{ intent, content, sources, toolTrace, tokens, violations, phaseMs }`.

**Eval** — see §4.

### 2.2 What Jeb keeps (`packages/jeb`)

- `compose.systemPrompt`, `voice`, `intent.classifyIntent` regexes, decline copy, `explain_pubky`.
- `answerMention` addenda (`EVIDENCE_MAP_ADDENDUM`, `CAPABILITY_ADDENDUM`, `TRANSLATE_ADDENDUM`, `WEB_SEARCH_ADDENDUM`).
- `REPLY_TAG_VOCABULARY` / `ARTIFACT_TAG_VOCAB` / `productCategory`.
- `drafts/*`, `sources.yaml`, knowledge prompt, eval YAML, dashboard, corrections.
- `contract-adapter.ts` (implements `BotAdapter`).
- `--role all` supervisor and operator CLIs.

### 2.3 Seams to introduce first (file:line)

These are Jeb identity hard-wired into code that should become Kit:

| Seam | Location | What to inject |
| --- | --- | --- |
| System prompt | `compose.ts:12–26` `systemPrompt()` “You are Jeb, a Synonym-operated…” | `BotIdentity.systemPrompt` |
| Thread prompt | `context.ts:56` role `"assistant Jeb"`; `context.ts:61` “You are Jeb (${botPk}), a Pubky answer bot” | identity + role labels |
| Scout voice | `scout/evidence.ts:5` “Mark interpretations as Jeb's”; `knowledge/prompt.ts:1` same | bot display name |
| Answer addenda | `answer.ts:21–54` | Jeb-only strings; Kit gets empty defaults |
| Intent catalog copy | `intent.ts:123–145` `intentGuidance`; `DECLINE_REPLY` `:148` | bot policy pack |
| Tag vocab | `reply-tags.ts:17–29` `REPLY_TAG_VOCABULARY` / `ARTIFACT_TAG_VOCAB`; `reply-tags.ts:46` `PRODUCT_CATEGORIES` | `TagCapability.vocab` |
| Env prefix | `config.ts` entire Zod object; `keys.ts:64+` `SHARED_ALLOWLIST`; `switches.ts:12–16` `JEB_SWITCH_*` | `BOT_*` or injected `envPrefix` |
| App URL | `links.ts:3–11` `DEFAULT_APP_URL` / `JEB_APP_URL` | `citationBaseUrl` |
| Raw Cypher flag | `scout/tools.ts:798` description `JEB_SCOUT_RAW_ENABLED`; `config` `scoutRawEnabled` | kit flag name |
| Outbound gate | `outbound-gate.ts:1–3` imports `systemPrompt` for scan corpus | pass prompt text in |

Do not extract `drafts/` into Kit until a second bot uses operator-approved standalone posts (Jeb uses it; Kit may include `enqueueStandalonePost` because publish already has it — Jeb uses it, so it is allowed).

---

## 3. Extraction order (independently shippable)

Each step: no Kit feature Jeb does not already call. First steps are move/re-export only (runtime identical). Proof: `vitest run` in Jeb + `CONTRACT_ADAPTER` against jeb-contract (HAPPY + restart idempotency at minimum). Size S/M/L.

| Step | Files moved | Seam | Proof | Size | Status |
| --- | --- | --- | --- | --- | --- |
| **0. Workspace skeleton** | Create `packages/bot-kit`, `packages/jeb`; tsconfig path aliases so Jeb imports `@pubky/bot-kit` that re-export current modules **in place** | none | typecheck; existing vitest | S | **done** `9cecc6f` |
| **1. Leaf utils** | `http`, `log`, `concurrency`, `shutdown`, `base32`, `text-normalize`, `nexus-schema`, `types` (split `ContractEnv` stay duplicated until §4) | none | vitest `base32`, nexus-schema tests | S | **done** `2aa5ec9` |
| **2. Nexus client + REST tools** | `nexus.ts`, `tools.ts` `nexusTools` only (leave Scout re-export as facade) | none | existing `tools.test.ts` | S | **done** `640ce07` |
| **3. Cursor + ingest** | `ingest.ts`, Store `getCursor`/`setCursor`/`ingest` SQL | none | ingest unit tests + contract HAPPY/duplicates | M | **done** `f0d8f1d` |
| **4. Context assembler** | `context.ts` | inject prompt strings (step 4a can copy-paste then replace literals) | `context.test.ts` | S | **done** `f529f07` |
| **5. Policy + switches** | `policy.ts`, `switches.ts`, Store switch/kill_switch | env prefix later | `policy.test.ts`, `reason-policy.test.ts` | M | **done** |
| **6. Scout stack** | `scout/client`, `guard`, `templates`, `tools`, `budget`, `circuit`, `types` | evidence.ts Jeb sentence → param | `scout.test.ts`, guard tests | L | **done** `ce7761a`
| **7. Security** | `secret-scrub`, `injection-detector`, `tool-screen`, `keys`, `auth-error` | `extraction-guard` rules stay Jeb-tunable | `secret-scrub.test.ts`, `keys.test.ts` | M | **done** `f29f944` |
| **8. Publish process** | `homeserver`, `post`, `upload`, `publish` gateway, Store `insertPublishRequest`/`claimPublish` | tag vocab injected into `tagOne` | `publish.test.ts` + contract crash-after-publish | L | **done** `ff65b41` |
| **9. Reason loop shell** | claim/reap work queue without `answerMention` | none | `work-reaper` / db tests | M | **done** `b0b2e6c`
| **10. Answer/tool loop** | `answer.ts` stays Jeb; Kit exports `createToolLoop({ nexus, scout, screen, compose })` only after seams in §2.3 | identity + addenda | `answer.test.ts`, eval:answers optional | L | **done** `b1fbe60` |
| **11. Knowledge mechanism** | store/retrieve/embed/chunker; Jeb keeps `sources.yaml` + prompt | product filters remain caller args | knowledge unit tests | L | **done** `5927a19` |
| **12. Web tools** | `web/*` | none | `web/search.test.ts` | S | **done** `58ef191` |
| **13. Eval harness** | generalise jeb-contract (§4) | adapter already exists | full `jeb-contract` suite | M | **done** `e9930b9` |
| **14. NL query service** | new process wrapping intent+tools; **after** 6+10 | schema() used | new vitest + Scout stub | L | **done** `a7a4414` |
| **15. Tagky capability** | extract `suggest_tags`/`apply_tags` from `reply-tags` + `enqueuePostTag` | vocab injection | `reply-tags.test.ts` | M | **done** `e4c98ba`

Steps 0–4 must not change runtime behaviour (re-export / move files, same symbols).

---

## 4. jeb-contract → Kit evaluation harness

**Today (adapter interface)** — `/Volumes/vibedrive/vibes-dev/jeb-contract/src/adapter.ts`:

```ts
export interface BotAdapter {
  start(env: ContractEnv): Promise<void>
  stop(): Promise<void>
  debugLastContext?(): DebugLastContext | undefined
}
```

`ContractEnv`: `nexusUrl`, `homeserverPk`, `signupToken`, `secretKeyHex`, `pgUrl?`, `cannedReply`, `modelDelayMs`, `maxRepliesPerThread`, `testnet`.

Load: `CONTRACT_ADAPTER` → default/class/`adapter` (`harness/load-adapter.ts:5`). Cases in `tests/contract.test.ts`: HAPPY, 404 parent, malformed, 5xx, 25-ancestor, 100 dupes, self-mention, bot-loop cap, `modelDelayMs`, crash-after-publish, overlapping poll, `pk:` prefix, kind long, reply-to-repost.

Jeb implementation: `src/contract-adapter.ts` `JebAdapter` spawns ingest/reason/publish (`:58–70`). Reference adapter in-contract is **not** a product (`reference-adapter/index.ts`).

**Needed to generalise as Kit harness**

| Today | Needed |
| --- | --- |
| Package name `jeb-contract`, canned “answer bot” | `pubky-bot-contract`; cases stay the same (mention → ≤1 valid `PubkyAppPost`) |
| `BotAdapter` sufficient | Keep; Kit bots implement it. Optional `debugLastContext` already optional |
| Env fields Jeb-shaped | Add optional `envPrefix`, `maxTurnsPerUser`, `blocklist` only if a second bot needs them — **do not add until Jeb uses them in contract** (Jeb already has those in runtime, not in ContractEnv) |
| Fixtures under `fixtures/staging/` | Stay; Kit documents fixture Nexus shapes (`nexus-types.ts`) |
| Knowledge/voice/redteam eval | **Stay in Jeb** (`scripts/eval-*.ts`). Contract is publish/idempotency/trust-boundary, not RAG quality |
| `src/types.ts` duplicates `ContractEnv` | Kit/Jeb import from contract package; delete duplicate |

Adapter vs runtime: harness never imports bot internals (README). Kit publish module is tested **through** the adapter, not by importing `runPublish`.

---

## 5. NL query service (§6.3) boundary

**Moves into a service (later process, not publish):**

- `intent.ts` `classifyIntent` / `toolsForIntent` / `FULL_TOOLS` (mechanism). Regex copy can stay Jeb-supplied.
- `scout/*` typed tools + `query_graph` + `guardRawCypher`.
- `nexus.ts` + `nexusTools`.
- `web/tools` if the service answers current-events (`research_web`).
- `ScoutClient.schema()` + `schema.golden.json` as **planning input** (unused in the answer loop today).

**Stays in Jeb (reason process):**

- `answer.ts` `answerMention` (compose, voice, extraction-guard, knowledge addenda, cannedReply).
- `reason.ts` policy, opt-out, skip/quota notices, work reap.
- `compose.ts` / `voice.ts`.

**Schema-aware planning — as it exists**

- Input: `GET {scoutUrl}/v1/schema` → `unknown` (`client.ts:80–84`). Golden: `src/scout/schema.golden.json` — nodes `User`/`Post`/`File`; relationships `FOLLOWS`, `AUTHORED`, `TAGGED` (User→Post and User→User), `REPLIED`, `REPOSTED`, `BOOKMARKED`, `MENTIONED`, `MUTED`; plus example Cypher strings.
- Planning today: **none**. The model picks tools from the Zod catalog; typed tools emit fixed templates (`scout/templates.ts`). Raw Cypher is model-authored then `guardRawCypher` (`tools.ts:801`).
- Service design: planner reads `/v1/schema` (fail-closed if schema fetch fails), maps intent → allowlisted tool, never invents relationship types not in schema; `query_graph` still guarded.

**Provenance output shapes today**

- Nexus REST: `{ uri, post|posts|user|tags|replies, provenance: "nexus" }` (`tools.ts:47–100`).
- Scout: spread `EvidenceMeta` (`provenance: "scout"`, `tool`, `truncated`, `notes`, `scope.time_range` / `graph_scope` / `filters`) plus tool-specific `posts` / `claims` / `tag_claims` / `clusters` / `topics` (`scout/types.ts:44`, `query_graph` return `tools.ts:816–823`).
- Knowledge: `publicRetrievalPayload` chunks `{ content, source_url, product, component, status, version, score }` + `truncated` (`retrieve.ts:29`).
- Answer traces: `AnswerResult.toolTrace` + `sources: string[]` (URIs).

NL service should return the same provenance objects so Jeb compose/evidence formatting stays unchanged.

---

## 6. Tagky capability (§6.4)

No Tagky repo under `/Volumes/vibedrive/vibes-dev` (ls only).

**Current paths**

1. **Reply self-tags** (bot’s own reply URI only):
   - Derive: `deriveCategories({ intent, toolTrace, products })` (`reply-tags.ts:92`) → max 3 of `answer|pubky|bitkit|paykit|graph|evidence-map|summary|declined`.
   - Reason writes `categories` onto `publish_requests`.
   - Publish: `tagOne` (`publish.ts:203`) → `putReplyTags` (`reply-tags.ts:121`) after reply PUT; `JEB_SELF_TAGS` can disable (`publish.ts:212`); kill switch `replies`.
2. **Artifact tags** (any public post, operator-approved):
   - Vocab: `sources-cited`, `debate`, `release-notes` (`reply-tags.ts:29`).
   - Queue: `enqueuePostTag` (`publish.ts:157`) / CLI `tags.ts` `apply|list|revoke`.
   - Publish: `applyArtifactTagOne` (`publish.ts:252`); `putArtifactTag` / `deleteArtifactTag`.
   - Migration `098_standalone_and_artifact_tags.sql`.

**Minimal Kit interface (only what Jeb uses)** — implemented in `packages/bot-kit/src/tags/`

```ts
suggestTags(input: {
  intent: string;
  toolTrace: unknown[];
  products?: string[];
  vocab: readonly string[];
  precedence?: readonly string[];
}): string[]
  // = deriveCategories with injected vocab/precedence, not hardcoded PRODUCT_CATEGORIES

applyTags(input: {
  targetUri: string;          // must be bot-authored for self-tags
  labels: string[];
  mode: "self" | "artifact";
  approvedBy?: string;        // required for artifact
}): Promise<{ uris: string[]; inserted: boolean }>
  // self: putReplyTags via publish process
  // artifact: enqueuePostTag + publisher PUT
```

Do not add ML suggestion Jeb does not have. `suggest_tags` is the existing deterministic derivation.

**Where per-bot tag accuracy is recorded**

- Today: no accuracy table. Evidence is operational: `publish_requests.categories`, `tag_uris`, artifact tag rows (`listArtifactTags`), logs `"reply tags published"`.
- Record accuracy in Jeb (not Kit): eval set of `{mention, expected_labels}` next to `scripts/eval-answers.ts`, or a column on `handled_mentions` / new `tag_eval_events(bot_id, mention_key, suggested, applied, judged_at)`. Kit only emits `suggested`/`applied` events; Jeb stores judgements.

---

## 7. Risks, open questions, choreography

### Risks

- **Store god-object** (`db.ts`): Kit needs a slim `QueueStore` (cursor, work, publish_requests, switches). Drafts/knowledge SQL stays Jeb or Kit-optional modules Jeb already uses (knowledge yes, drafts yes → both allowed, but split so NL service does not pull drafts).
- **`Config` monolith**: every Kit function takes Jeb `Config`. First extraction should pass narrow `Pick<Config, …>` (already started in `ScoutClient`).
- **Three-process boundary** is the product. Extracting publish into a library that reason can import would violate trust; Kit must keep `assertNoKeyMaterial` on non-publish entrypoints (`keys.ts:29`).
- **Schema planner gap**: calling `/v1/schema` without using it in `query_graph` is a false §6.3. Do not advertise schema-aware planning until a planner exists.
- **Env rename** (`JEB_*` → generic) is a behaviour change; do it last, behind aliases.
- Concurrent audit on this tree: do not restyle/move until that audit lands.

### Open questions

1. Is `packages/bot-kit` inside this repo (monorepo) or a new BitcoinErrorLog package? Extraction steps assume in-repo first.
2. Should Kit’s `Store` own migrations `001`–`099` or only a subset (`cursor_state`, `handled_mentions`, `work`, `publish_requests`, `switches`, `scout_queries`)? Jeb-only: drafts, knowledge, corrections, optouts.
3. NL query as a **fourth** process vs a library called from reason? Plan §6.3 says service; Jeb today in-process. Recommend library first (step 14), process split after a second consumer.
4. ContractEnv.pgUrl required for Jeb, optional in the interface — keep optional.

### Agent choreography (execute steps 1–3 = inventory steps 0–4)

Parent-only: git commit/push, this doc, user replies. Sub-agents: no `git push` / `gh` / remote write. Max 6 concurrent. One git working tree per wave (use git worktrees). Models: newest `cursor-grok-*` lowest effort that fits for implementation; **Kimi via OpenCode** for publish/key/policy/secret-scrub (not those in waves 0–4). Reviews: different family than implementer.

| Wave | Steps | Worktree | Agents | Model | Kimi | Proof (parent re-runs) |
| --- | --- | --- | --- | --- | --- | --- |
| A | 0 skeleton + 1 leaf utils | `wt-kit-a` | 1 implement | Grok low | N/A — no key/policy/publish | `npx vitest run src/base32.test.ts` (and any moved leaf tests) |
| B | 2 Nexus + REST tools | `wt-kit-b` | 1 implement | Grok low | N/A | `vitest` tools/nexus tests |
| C | 3 ingest/cursor | `wt-kit-c` | 1 implement | Grok low | N/A (queue not signing) | ingest tests; optional contract HAPPY if adapter still builds |
| D | 4 context assembler + first prompt seam | `wt-kit-d` | 1 implement | Grok low | N/A | `context.test.ts`; canned replies unchanged |
| R | review A–D | read-only | 1 review | different family from Grok | N/A | parent confirms vitest green |

Later waves (not 1–3, listed so Kimi is not skipped):

| Wave | Steps | Kimi |
| --- | --- | --- |
| E | 5 policy + switches | **Required** — fail-closed policy |
| F | 7 keys + secret-scrub | **Required** |
| G | 8 publish gateway | **Required** — key process, `PublishRequest`, kill switches |
| H | 6 Scout + 10 answer | Kimi on `guard.ts` / raw Cypher |

**Kimi audit: N/A** for waves A–D (no new crypto, key handling, or publish path). **Required** before marking E/F/G done. If OpenCode/Kimi cannot run, stop; do not mark those waves done.

Effort: A–B S (~0.5d), C M, D S. No stubs. If scope explodes (Store split), stop and ask before cutting drafts out of `db.ts`.
