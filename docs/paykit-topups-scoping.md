# Jeb budget top-ups over Paykit (Stage 6.1 scoping)

**Date:** 2026-09-04  
**Status:** read-only survey. No implementation.  
**Plan source:** §9.1 of `/Volumes/vibedrive/vibes-dev/.cursor/plans/jeb_rise_of_the_robots_9c1e4b27.plan.md`  
**Paykit tree surveyed:** `/Volumes/vibedrive/vibes-dev/paykit-rs` (this workspace).  
**Locks:** README only, `/Volumes/vibedrive/vibes-dev/pubky-locks/README.md`.  
**Bitkit:** receive/confirm surfaces only.

---

## 0. What §9.1 asks for

Users pay bitcoin (on-chain or Lightning) via Paykit to raise Jeb’s token budget. Free allocation stays free. A top-up adds tokens for a period (day / week / month), either scoped to the payer’s pubky or to the global pool. Jeb publishes a price list; receipts are stored as evidence; a public ledger post records amount, tokens, period, and payer unless they opt out. Paying must not buy priority, private answers, or policy changes. Refunds only for failed provisioning. Prerequisites in the plan: Paykit receipts/requests stable on mainnet; Locks optional for weekly/monthly tiers; Kimi audit of request signing, receipt verification, credit accounting, refunds.

Jeb today: Node/TypeScript, Postgres. Global and per-user UTC-day token ceilings. No `budget_credits` table and no Paykit code.

---

## 1. What Paykit is in this tree (crates, versions, maturity)

### 1.1 Two libraries, not one

`paykit-rs/README.md` (lines 5–17) states this checkout is **WIP, not for production**, and **deprecated as a dependency** (June 2026) versus official `pubky/paykit-rs` (cited as 0.1.0-rc12), with **no shared git history**. New product code must not take a Cargo dependency on *this* repo without an explicit decision.

Bitkit Android already talks to a different crate: `com.synonym.paykit` (`PaykitPaymentRequestRepo.kt` imports `PaymentRequestRecord`, `PaymentRequestLifecycleState`, etc.). That is the official UniFFI surface, not `paykit-mobile` in this tree.

Scoping below describes **this** workspace because that is what was asked. Any Jeb build must pick a canonical Paykit (official vs this fork) before writing code.

### 1.2 Workspace members (`paykit-rs/Cargo.toml`)

| Crate | Version (`Cargo.toml`) | Role |
| --- | --- | --- |
| `paykit-lib` | 2.0.0 | Directory, transport traits, plugins, LND/Esplora executors, protocol paths |
| `paykit-interactive` | 0.2.0 | Noise messages + `PaykitReceipt` |
| `paykit-subscriptions` | 0.3.0 | Requests, proposals, auto-pay |
| `paykit-demo-core` | (workspace) | Shared demo logic |
| `paykit-demo-cli` | 0.1.0 | Binary `paykit-demo` |
| `paykit-demo-web` | 0.1.0 | `cdylib` wasm-bindgen browser demo |
| `paykit-mobile` | 0.2.0 | UniFFI `cdylib`/`staticlib` for Swift/Kotlin (Python generator exists) |

There is **no** `paykit-ffi` crate, **no** `napi` crate, **no** published npm wasm package. `DEPLOYMENT.md` lists napi-rs + Electron as a **planned** desktop app (`paykit-demo-desktop`), not present as a workspace member.

`paykit-lib` default feature `pubky` pulls `pubky` from `git://github.com/BitcoinErrorLog/pubky-core` rev `290d801` (`paykit-lib/Cargo.toml`). Optional `http-executor` (reqwest) is **not WASM-compatible**.

README self-describes “100+ tests”. This tree has on the order of 113 Rust files containing `#[test]` / `#[tokio::test]`, plus `paykit-lib` benches. README also says “In Progress: Full Noise protocol integration for live payments.” `LightningPlugin` documents BOLT12 as **unsupported** (`paykit-lib/src/methods/lightning.rs`).

### 1.3 Node caller surfaces today

| Surface | Exists? | Usable from Jeb Node? |
| --- | --- | --- |
| **(a) wasm-pack / wasm-bindgen** | `paykit-demo-web` (`crate-type = ["cdylib","rlib"]`, wasm-bindgen). `paykit-lib` has `cfg(target_arch = "wasm32")` Web Crypto/IndexedDB deps. Subscriptions/interactive are **not** wired into that wasm crate (`paykit-demo-web/Cargo.toml` comments). | Browser demo, not a Node `require()`. No `wasm-pack` output for server. `http-executor` excluded on wasm. |
| **(b) UniFFI** | `paykit-mobile`: Swift, Kotlin, and a **Python** bindgen language (`src/bin/generate_bindings.rs`). Tokio in the crate; README warns it cannot run in iOS notification extensions. | No TypeScript/NAPI target. Python is generator-only, not a Jeb path. Bitkit uses **official** `com.synonym.paykit`, not this crate. |
| **(c) CLI binary** | `paykit-demo` (`paykit-demo-cli`): setup, discover, publish endpoints, pay (LND/Esplora behind `http-executor`), receive (TCP Noise listener), receipts, subscriptions. | Spawnable. Demo-grade identity storage (encrypted files). Not a stable JSON-RPC API. |
| **(d) Homeserver HTTP / Pubky SDK** | Canonical paths in `paykit-lib/src/protocol/mod.rs` and `protocol/paths.rs`. Writes go through `HomeserverSessionStorage` (`put` UTF-8). | Jeb already has `@synonymdev/pubky` for `session.storage.put`. Can PUT/GET the same paths without Rust. |
| **(e) Lightning / on-chain execute** | Payer-side plugins + `LndExecutor` / Esplora. Receiver-side invoice minting is **not** in `LightningExecutor` (pay/decode/fee/get/verify_preimage only). | Jeb as **receiver** still needs an LN node, LNURL service, or hosted wallet. Paykit does not replace that. No Blocktank references in this `paykit-rs` tree. |

---

## 2. On-disk / homeserver format (from code)

Prefix: `PAYKIT_PATH_PREFIX = "/pub/paykit.app/v0/"` (`paykit-lib/src/transport/pubky/mod.rs`). Protocol table (`protocol/mod.rs`):

| Object | Path | Who stores it |
| --- | --- | --- |
| Payment method endpoint | `/pub/paykit.app/v0/{method_id}` | payee |
| Optional snapshot | `/pub/paykit.app/v0/supported.json` | payee (`SUPPORTED_METHODS_INDEX_PATH` in `lib.rs`) |
| Noise endpoint | `/pub/paykit.app/v0/noise` | payee |
| Payment request | `/pub/paykit.app/v0/requests/{context_id}/{request_id}` | **sender** |
| Subscription proposal/agreement/cancel | `/pub/paykit.app/v0/subscriptions/...` | provider / parties |
| ACK | `/pub/paykit.app/v0/acks/{object_type}/{context_id}/{msg_id}` | receiver |
| Handoff | `/pub/paykit.app/v0/handoff/{request_id}` | Ring user |

`upsert_payment_endpoint` writes `PUT {PAYKIT_PATH_PREFIX}{method_id}` with body = `EndpointData.0` (raw UTF-8 string), not a wrapper schema (`homeserver_session_storage.rs`). `EndpointData` is documented as UTF-8 text: address, LNURL, JSON, etc. (`lib.rs`).

Discovery: `PubkyUnauthenticatedTransport::fetch_supported_payments` lists `pubky{payee}/pub/paykit.app/v0/`, skips directories, uses last path segment as `method_id`, GETs each file as endpoint payload (`unauthenticated_transport.rs`). Per-method files are source of truth; `supported.json` is optional (`get_supported_snapshot` docs in `lib.rs`).

Lightning endpoint body parsing (`lightning.rs` `parse_payment_data`): JSON with `bolt11` or `lnurl`; else string starting `lnurl`; else treat as BOLT11.

On-chain: address string (legacy / P2SH-SegWit / bech32) via `OnchainPlugin`.

`context_id` in `protocol/mod.rs`: hex(sha256("paykit:v0:context:" + sorted z32 pair)). `paths.rs` notes PUBKY_CRYPTO_SPEC v2.5 prefers 32 random bytes for new threads; pair-derived path is legacy.

Requests under `/requests/` are described as encrypted, addressed to a recipient (`payment_request_path` docs). A Node reimplementation of sealed-blob requests is not “just JSON PUT”.

---

## 3. Payer flow vs receiver flow (as implemented)

### 3.1 Payer (Bitkit / CLI)

1. **Discover** payee methods: list `/pub/paykit.app/v0/` (CLI `discover`; `get_payment_list`).
2. **Optional interactive path:** Noise_IK (`paykit-interactive`, CLI `pay.rs` if `pubky://` URI) — `RequestReceipt` / `ConfirmReceipt` (`PaykitNoiseMessage` in `paykit-interactive/src/lib.rs`). Demo `receive.rs` “confirms” the receipt as-is; comment says production would generate invoices.
3. **Execute off-protocol:** `LightningPlugin::execute_payment` pays BOLT11/LNURL via `LightningExecutor::pay_invoice` (`LndExecutor` REST). `OnchainPlugin` via `BitcoinExecutor` / Esplora. BOLT12: not supported.
4. **Proof:** `PaymentProof::LightningPreimage { preimage, payment_hash }` or `BitcoinTxid { txid, block_height, confirmations }` (`methods/traits.rs`). Interactive layer wraps this in `paykit-interactive/src/proof/mod.rs`. CLI `pay.rs` builds a lightning_preimage proof after LND pay.
5. **Receipt object:** `PaykitReceipt` (`paykit-interactive/src/lib.rs`): `receipt_id`, `payer`/`payee` PublicKey, `method_id`, optional `amount`/`currency`, `created_at`, free-form `metadata`. **No `proof` field on this struct.** Locks README expects extra `proof` + `asset` on a BIP-Paykit receipt — that is the spec README, not this struct. Bitkit’s official SDK has a richer `PaymentRequestRecord` lifecycle (`PROPOSED` → accept/reject in `PaykitPaymentRequestRepo.kt`).

iOS: after a receive refresh, `WalletViewModel` refreshes public Paykit endpoints (log string in `WalletViewModel.swift`). Receiver Noise secret is a separate Keychain entry (`Keychain.swift` `paykitReceiverNoiseSecretKey`). That is wallet-side receiving, not a Node service.

### 3.2 Receiver (what Jeb would be)

Paykit **coordinates discovery and proofs**. It does **not** run a Lightning node.

To **receive** Lightning:

- Publish an endpoint: static LNURL or a BOLT11 (BOLT11 expires; bad as a standing directory file unless rotated).
- `LightningPlugin::generate_endpoint` is **not** overridden; the trait default returns `Unimplemented` (`methods/traits.rs`). CLI `publish` takes operator-supplied address/invoice strings (`commands/publish.rs`).
- `LightningExecutor` has **no** `add_invoice`. Preimage is released by the **payee’s** LN node when the HTLC settles. `verify_lightning_proof` without an executor only checks 64-char hex; with executor it SHA256(preimage)==hash (`lightning.rs`, `executor.rs` default `verify_preimage`).
- Address rotation exists as policy/state in `paykit-lib/src/rotation.rs` and CLI `rotation.rs` — privacy for **on-chain reuse**, still needs a wallet that can mint new addresses.

On-chain receive: publish `bc1…`, watch via Esplora (`executors/esplora.rs`) `verify_transaction`.

Blocktank: not used by this Paykit tree. Bitkit apps use Blocktank for **channels**, which is orthogonal to Paykit directory objects.

Jeb cannot “receive Paykit” by publishing posts alone. Someone must hold LN/on-chain keys and observe settlement.

### 3.3 Demo receive

`paykit-demo-cli/src/commands/receive.rs`: TCP Noise server, `DemoReceiptGenerator` echoes the request. Local JSON receipt store. Not a production listener for Jeb.

---

## 4. Jeb budget machinery (today)

| Item | Where |
| --- | --- |
| Global UTC-day ceiling | `JEB_DAILY_TOKEN_BUDGET`, default `DEFAULT_DAILY_TOKEN_BUDGET = 5_000_000` (`src/config.ts`) |
| Per-asker UTC-day ceiling | `JEB_USER_DAILY_TOKEN_BUDGET`, default `600_000` |
| List prices | `JEB_MODEL_PRICE_PER_MTOK_IN` 0.6, `OUT` 2.5 USD / 1M (`config.ts`; `docs/cost-bounds.md`) |
| Enforcement | `budgetExceeded` in `src/policy.ts`: p50 typical answer tokens (fallback 20_000) + UTC-day sums from `token_usage`; fail-closed on DB error |
| Spend table | `token_usage` in `migrations/001_jeb_foundation.sql`; sums in `src/db.ts` `globalDailyTokens` / `userDailyTokens` |
| Skip notice | `SKIP_NOTICE_TEXT.budget` in `src/skip-notice.ts`; `docs/limits.md` |
| Last-allowed prefix | `src/quota-notice.ts`: `user_daily_budget` / `global_daily_budget` — **no** “your top-up covers this” string yet. `docs/cost-bounds.md` says top-ups are not available (plan 9.1). |
| Publisher isolation | `assertNoKeyMaterial` / allowlists in `src/keys.ts`: ingest/reason never get `PUBKY_BOT_*`. Only publish role has the homeserver session key. |

§9.1’s “publisher signs payment requests like posts” **conflicts** with putting a **payment wallet** on the publisher process. Directory PUTs can use a **payee identity**; LN macaroons / xpubs must not share that process or that key.

---

## 5. Three integration options for Jeb

Assumption: Jeb is a **payee**. Payers are Bitkit (or another Paykit wallet). Jeb verifies settlement and credits Postgres.

### Option A — TypeScript against homeserver format (no Rust)

**What:** Publisher (or a dedicated “payee” process) PUTs `/pub/paykit.app/v0/lightning` and `/onchain` using the existing Pubky session API. Price/request UX is a post + optional static endpoint on the profile. Settlement: poll LN node / LNURL provider / Esplora; or accept a pasted preimage/txid and verify.

**Effort:** **M** for directory + ledger + budget hook; **L** if reimplementing sealed payment requests, Noise, and AAD (`protocol/aad.rs`).

**Needs:** LN receive stack (node, or LNURL-pay hosted by Synonym). Separate **payment identity** (see §7). BTC price feed if pricing in sats from USD list prices.

**Risks:** Request encryption and official Bitkit SDK diverge from this fork. Static BOLT11 in the directory expires. Preimage-without-node is forgeable unless you check SHA256 and that **your** node generated that hash. Official vs this-repo path layouts (`/pub/paykit.app/v0/` here vs Bitkit tests mentioning `/pub/paykit/v0/`).

### Option B — Rust sidecar / CLI over `paykit-lib`

**What:** Small binary: publish endpoints, optionally listen for requests (if using this crate’s protocol), verify proofs via LND REST / Esplora, print JSON to stdout for Jeb. Jeb never links Rust.

**Effort:** **M** if wrapping CLI `publish`+`pay` verification only; **L** to harden demo identity storage, stable IPC, and mainnet LND.

**Needs:** Same LN node. Sidecar holds payment keys / macaroon, not `PUBKY_BOT_SECRET`. Pin **which** Paykit git (this 2.0.0 tree vs official 0.1.0-rc12).

**Risks:** This repo’s README forbids depending on it. Demo CLI is not an API. Tokio + UniFFI mobile crate is the wrong shape for a server sidecar (`paykit-mobile` warning).

### Option C — Wait for wasm / napi

**What:** Node-native or wasm bindings of `paykit-lib`.

**Effort:** **L** (new crate, bindgen, no existing napi; wasm demo has no executors). Calendar wait is unbounded.

**Needs:** Same custody/LN as A/B plus a bindings project.

**Risks:** Does not unblock receiving money. Bindings help **payers** in JS more than Jeb.

---

## 6. Ledger design (`budget_topups`)

New table (suggested). Not in the repo today.

```sql
CREATE TABLE budget_topups (
  id BIGSERIAL PRIMARY KEY,
  payer_pubky TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('user', 'global')),
  period TEXT NOT NULL CHECK (period IN ('day', 'week', 'month')),
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  amount_sats BIGINT NOT NULL CHECK (amount_sats > 0),
  tokens_granted INTEGER NOT NULL CHECK (tokens_granted > 0),
  proof_ref TEXT NOT NULL,          -- preimage hex, txid, or receipt URI
  proof_type TEXT NOT NULL CHECK (proof_type IN ('lightning_preimage', 'bitcoin_txid')),
  receipt_uri TEXT,                 -- public homeserver or ledger post
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'confirmed', 'credited', 'refund_pending', 'refunded', 'failed', 'expired'
  )),
  beneficiary_pubky TEXT,           -- default payer; never a blocklisted id
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (proof_ref)                -- replay
);
```

**Compose with existing budgets** (`policy.ts` `budgetExceeded`):

- Effective ceiling = env default + sum of `credited` rows whose `period_*` covers `now()`, scoped: `user` credits add to that asker’s `user` ceiling; `global` credits add to `JEB_DAILY_TOKEN_BUDGET` (and weekly/monthly windows need extra counters, not only `date_trunc('day')`).
- Plan: **credits drain before the free pool**. Implementation: when computing remaining headroom, subtract spend from credited tokens first (per scope), then from the free ceiling. `token_usage` stays the spend ledger; top-ups only raise caps / remaining credit.
- Quota prefix (`quota-notice.ts`): if the last allowed answer is funded by remaining credit, use a new rule (e.g. `topup_credit`) *before* `user_daily_budget`: “Your top-up covers this; the extra budget ends {period_end}.” Do not stack prefixes (existing first-match rule).

**Price schedule** from `docs/cost-bounds.md` / `src/cost-bounds.ts`:

- 5_000_000 tokens ≈ **$3.00 input / $12.50 output** list (Kimi K3 family 0.6 / 2.5 per 1M).
- 600_000 tokens ≈ **$0.36 / $1.50**.
- Typical answer fallback 20_000 tokens (`TYPICAL_ANSWER_TOKENS_FALLBACK`).
- Tokens-per-sat = f(USD/sat, chosen list side, stated margin). **Do not hardcode sats** until BTC/USD and margin are chosen. Publish the formula on the profile with `docs/limits.md`.

Suggested SKUs (illustrative, not prices in sats): user-day +600k; user-week 7×600k with a discount cap; global-day +N×typical. Weekly/monthly need spend tracking beyond UTC-day (`token_usage` is already timestamped).

**Refunds / expiry:** `period_end` lapses unused credit (`expired`). Refund sats only if `status` never reached `credited` (payment seen, credit write failed) — automatic, same wallet. No refund of consumed tokens.

**Abuse:**

| Vector | Mitigation |
| --- | --- |
| Pay to raise a **blocklisted** user | Reject `beneficiary_pubky` in `blacklist` / `JEB_BLOCKLIST` (`src/policy.ts`). |
| Pay to raise an **opted-out** user | Credits do not override `user_optouts`; they still get silent skip. |
| Exhaust **someone else** | User-scoped credits only raise **payer** (or explicit beneficiary who is not blocked). Cannot debit another user’s free cap. |
| Exhaust **global** via tiny pays | Minimum `amount_sats`; rate-limit pending rows; global SKU is sponsorship of the shared pool (plan: “sponsor the global pool”), which increases capacity rather than stealing others’ free cap. |
| Replay proofs | `UNIQUE (proof_ref)`; verify hash belongs to **this** payee invoice. |
| Priority / private answers | Unchanged: no queue jump (`§9.1`). |

Hourly / thread / turn caps (`limits.md`) stay; money does not lift those unless explicitly decided (recommend **no**).

Public ledger post: publisher PUTs a summary; do not put preimages on the public graph (only `receipt_id` / txid as needed).

---

## 7. Key custody (non-negotiable)

| Key | Process | Role |
| --- | --- | --- |
| Publisher Ed25519 (`PUBKY_BOT_SECRET_*`) | `--role publish` only (`src/keys.ts`) | Posts, profile, optional **directory PUT** if payee == bot identity |
| Payment / LN / on-chain | Separate host or sidecar; never reason/ingest | Invoice mint, macaroon, xpub/descriptor |
| Payee pubky for Paykit directory | May equal bot identity **or** a dedicated payee key listed on the profile | Discovery |

Do not derive the LN seed from the bot mnemonic. Do not put LND macaroons in publisher env. §9.1 “Jeb never holds funds” means the **bot app** does not custody; Synonym’s wallet/node does, behind a trust boundary.

---

## 8. What Locks would add (README only)

`pubky-locks/README.md`: Locks **verifies proofs**, does not move money. Paykit produces receipts; Locks consumes them in a `ProofBundle`; homeserver issues `UnlockGrant`.

Useful later: gate “weekly/monthly extra budget” as a locked resource (payment criterion, `receipt_window_sec`, `lock_commitment`). Homeserver payment verifier: match payee/amount/asset, Lightning SHA256(preimage)==hash, optional on-chain HTTP (`§15`). **No paykit-lib required** (`§15.5`).

For Jeb top-ups, Locks is **optional** (plan §9.1). Jeb is not a homeserver; it would either (1) treat itself as the verifier (same checks in Postgres) or (2) wait for Locks on Jeb’s homeserver and credit from grants. MVP should not wait.

---

## 9. Recommendation and first milestone

**Recommend Option A for the ledger and budget hook, plus a Synonym-controlled LN receive path (LNURL or node), not UniFFI/wasm.** Use Paykit only as **public method discovery** (`/pub/paykit.app/v0/lightning` = LNURL). Do not spawn `paykit-demo` in production. Do not Cargo-depend this deprecated tree until it is aligned with official `pubky/paykit-rs` / Bitkit `com.synonym.paykit`.

If Bitkit already pays official Payment Requests, the first integration test is: **Bitkit pays Jeb’s published LNURL**, Jeb’s node sees the invoice, Jeb credits `budget_topups`. Directory PUT can be done with the existing Pubky SDK.

**Minimal first milestone**

1. Dedicated payment receive (LNURL-pay or LND) **not** in the publisher container.
2. PUT lightning endpoint on the payee homeserver path above.
3. `budget_topups` + `budgetExceeded` consults confirmed user-scoped **daily** credits only.
4. Mention intent “top up” replies with amount, sats (once priced), and the LNURL/Paykit URI — no Noise yet.
5. Quota prefix + skip notice mention remaining credit; `docs/cost-bounds.md` regenerated when live.
6. Kimi audit: proof verification, unique `proof_ref`, key isolation, refund of `pending` only.

Out of milestone: weekly/monthly, global sponsor SKU, on-chain, Locks, wasm/napi, sealed `/requests/` protocol.

---

## 10. Open questions

1. Canonical Paykit: official `pubky/paykit-rs` 0.1.0-rc12 (Bitkit) vs this workspace `paykit-lib` 2.0.0?
2. Payee identity: same as Jeb’s production key, or a separate payment pubky?
3. Who hosts LN: Synonym LND, hosted LNURL, Bitkit watch-only, other?
4. Quote sats using input list, output list, blended, and what USD/BTC source + margin?
5. May A pay extra budget for B (gift), or only self / global?
6. Do paid tokens bypass hourly/thread/turn caps? (This doc recommends no.)
7. Public ledger: required for v1 or operator-only until mainnet receipts stabilize?
8. Path string Bitkit wallets actually GET (`paykit.app` vs `paykit`)?
9. Is a static LNURL enough for Bitkit discovery, or must Jeb emit official `PaymentRequestRecord`s?

---

## File index (claims)

- Plan §9.1: `.cursor/plans/jeb_rise_of_the_robots_9c1e4b27.plan.md`
- Jeb budgets: `pubky-ai-bot-jeb/src/config.ts`, `policy.ts`, `quota-notice.ts`, `skip-notice.ts`, `keys.ts`, `db.ts`, `cost-bounds.ts`, `docs/cost-bounds.md`, `docs/limits.md`, `migrations/001_jeb_foundation.sql`
- Paykit crates: `paykit-rs/Cargo.toml`, `README.md`, `paykit-lib/src/{lib.rs,protocol/mod.rs,protocol/paths.rs,transport/pubky/mod.rs,transport/traits.rs,transport/pubky/*.rs,methods/{lightning,onchain,traits,executor}.rs,executors/lnd.rs}`
- Receipts/proofs: `paykit-interactive/src/{lib.rs,proof/mod.rs}`, CLI `pay.rs` / `receive.rs` / `publish.rs`
- Bindings: `paykit-mobile/Cargo.toml`, `src/bin/generate_bindings.rs`, `paykit-demo-web/Cargo.toml`, `DEPLOYMENT.md` (napi planned)
- Bitkit: `PaykitPaymentRequestRepo.kt`, `WalletViewModel.swift` (endpoint refresh), `Keychain.swift`
- Locks: `pubky-locks/README.md` §§1–2, 7.2, 11, 15
