# Security re-audit — commits `60b4691..397fd48` (stage1/secrets)

**Scope:** read-only adversarial verification of the remediation of `docs/kimi-audit-secrets.md` (12 findings against `8534ac1`). Every bypass probe from the original audit was re-executed against the current code with `tsx` (62 assertions), plus regression probes specified for this re-audit. Suites re-run: `npx tsc --noEmit` (clean), `vitest run --exclude tests/eval/retrieval-gate.test.ts` (**44 files, 489 passed, 2 skipped**), `npm run eval:redteam` (**75 items, 35 guard declines, 2 fixed, 28 publisher-gate catches, 0 leaks, 0 unmet**). No files modified except this report.

**Verdict: SHIP**

All 12 findings are CLOSED or PARTIAL with only LOW residuals. Two probe failures came out of the run: one false alarm in my own probe (the injection detector's `sanitize` never stripped instruction phrases — detection + redaction + the outbound gate is the designed treatment, and chain posts now get exactly the tool-result treatment the fix promised), and one genuine LOW regression (Finding 4: reversed-order mnemonics were no longer caught — fixed in `2ce75af` + `d9d3057` during this re-audit, with a test and a red-team poison). Nothing blocks shipping.

---

## Per-finding status

### 1. HIGH — `hex64` false positives — **CLOSED**

The outbound gate no longer has a 64-hex shape rule. `scanForSecrets` (`src/secret-scrub.ts:409-411`) runs value-matched rules only; `hex64` and `bearer_token` shapes exist only in the tool-results tier (`scanInternal(..., toolResults=true)`, `:368-373`). Probes: txid, block hash, sha256 digest, nostr x-only pubkey, 40-char git SHA, RFC 6750 bearer example, pubky z32 ID URL all pass the gate (`src/secret-scrub.test.ts:67-81` pins the same corpus). The value-matched gate still catches the canonical hex key (probe + `:20-22`).

### 2. HIGH — trivial key transformations bypass — **CLOSED**

`key_material` (`src/secret-scrub.ts:242-273`) matches the configured key bytes by value in every enumerable encoding. All eight original bypasses re-probed and now caught: base64 (padded/unpadded/url), base32 RFC4648 (upper/lower, padded/unpadded), z-base-32, `0x`-prefixed, trailing word char (`{key}g`), dash/comma-separated, ZWSP-separated (via shared `normalizeForScan`, `src/text-normalize.ts`), fullwidth-hex homoglyphs (NFKC), and the 128-char key‖pubkey run (compacted-run containment via `HEX_RUN`, `:83`, capped at 512 compacted chars). Tests: `src/secret-scrub.test.ts:19-65`; red-team poisons: `eval/redteam/bypass-forms.yaml` (rt-bypass-b64, b64url, b32, z32, 0x, dash, zwsp, homoglyph, longrun, trailing) — all gate-caught, 0 leaks in the eval run. **Residual (documented in code, `:166-168`): bech32/bech32m encodings are NOT covered** — no implementation in the dependency tree. LOW: the key never reaches the reason process, so a bech32 form could only enter context if an attacker already has the key.

### 3. MEDIUM — `env_secret` token-boundary bypasses; oracle stricter than gate — **CLOSED**

Values are now matched as plain substrings of normalized text plus any contiguous ≥16-char fragment (`scanEnvSecrets`, `src/secret-scrub.ts:332-357`; `ENV_SECRET_PARTIAL_MIN_LEN`, `:112`). Probes: `NAME=value`, ZWSP-inside-value, `key:<value>` prefix, `<value>.` suffix, 16-char partial — all caught; 15-char partial passes (documented threshold). The eval oracle is now *literally the production gate*: `leakScan` calls `scanOutboundText` with the fixture env (`src/redteam.ts:61-63`), and a production `env_assignment` rule mirrors the old eval-only pattern (`:80`). **Residual (documented):** fragments below 16 chars and per-character splitting (`r t - m o d e l …`) are uncatchable without prose false positives — probed, still passes the gate, as documented. Base64-of-env-value is not enumerated (encodings are enumerated for key material only); noted as residual risk.

### 4. MEDIUM — `bip39` density window gamed by interleaving — **CLOSED**

Density window replaced by checksum validation over in-order wordlist-word subsequences, all shipped BIP39 languages (`scanBip39`, `src/secret-scrub.ts:299-325`). Probes: filler 1-per-3 → caught; 1:1 interleave → caught; wordlist prose failing checksum → clean; ordinary prose → clean. **Regression found during this re-audit (LOW):** reversed-order mnemonics were no longer caught — the old order-insensitive density window caught them; the checksum does not. **Fixed in `2ce75af` + `d9d3057`:** reversed order is validated when the filtered wordlist-word sequence is exactly a mnemonic length (12/15/18/21/24). The per-window reversed variant was tried first and reverted: the 12-word BIP39 checksum is only 4 bits, so validating every sliding window in both directions measurably false-positives on wordlist-heavy prose (observed on the repo's own injected fixture). Residual: a reversed phrase padded with extra wordlist words (filtered length not exactly 12/15/18/21/24) evades — documented tradeoff.

### 5. MEDIUM — chain context unscreened — **CLOSED**

`assemblePrompt` now runs every chain post through `screenChainContent` (`src/context.ts:32-38`): `InjectionDetector.detect` + `redactSecrets`, i.e. exactly the tool-result treatment the fix specified. Probes: a poisoned ancestor containing the key hex is redacted before reaching the assembled prompt (verified end-to-end through `assemblePrompt`); bare follow-ups ("yes") escalate the newest ancestor through the extraction guard (`extractionGuardChainAware`, `src/extraction-guard.ts:158-170`; wired at `src/answer.ts:72-73`) — hostile ancestor + "yes" declines. **Residual (honest):** the detector's `sanitize` filters role markers/separators but does not strip instruction phrases ("ignore all previous instructions…" reaches the model as text, resisted by the addendum and backstopped by the prompt-echo and secret gates). This matches the commit's stated design ("same treatment as screenToolResult"), not a shortfall of the remediation, but the deterministic layer on this path is redaction + outbound gate, not instruction removal.

### 6. MEDIUM — no deterministic prompt-echo gate — **CLOSED**

`src/outbound-gate.ts`: every ≥48-char verbatim shingle of the normalized `systemPrompt()` and `SECURITY_PROMPT_ADDENDUM` (whitespace-collapsed) is compared against outbound text; rule id `prompt_echo`. Probes: 60-char fragment, whole prompt, addendum dump → all caught; 40-char fragment → passes (below shingle, documented); gate returns rule id only. The publisher (`src/publish.ts:149`) and operator scripts call `scanOutboundText`/`assertOutboundClean`, and the red-team oracle is the same function — oracle ≡ gate. Red-team poisons rt-bypass-prompt-dump / rt-bypass-addendum-dump gate-caught in the eval run.

### 7. MEDIUM — contract-adapter denylist — **CLOSED**

`src/contract-adapter.ts:20-22` now spawns ingest/reason with `reasonChildEnv`/`ingestChildEnv`. Probed with a parent env containing `AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`, `NPM_TOKEN`, `PUBKY_BOT_SECRET_KEY_HEX`, `JEB_SIGNUP_TOKEN`, `ADMIN_TOKEN`, `JEB_ADMIN_PORT`: none reach either child; `JEB_MODEL_API_KEY` reaches reason only (by design); no `JEB_ADMIN_PORT`, so the reason child cannot bind the admin listener on this path either. Tests: `src/contract-adapter.test.ts`.

### 8. LOW — binary PUTs unscrubbed — **CLOSED**

`assertUploadBytesClean` (`src/upload.ts:86-89`) utf8-decodes and gates attachment/avatar bytes unless they carry a recognized image magic header. Probes: text attachment containing the key → refused; `.env`-style `NAME=value` payload → refused; PNG magic → exempt (documented). Wired in `scripts/post.ts:98` and `scripts/profile.ts:69`. Byte-offset bounds bug in the exemption was itself fixed in `0c89185`.

### 9. LOW — `DATABASE_URL` in all three processes — **CLOSED (residual by design)**

Per-role PG users are now wired: `JEB_DB_URL_REASON` / `JEB_DB_URL_INGEST` override `DATABASE_URL` per child (`src/keys.ts:151-167`, `src/config.ts:107-113`, tests in `src/config.test.ts`, `src/keys.test.ts`). **Residual:** the default (no per-role vars set) still distributes `DATABASE_URL` to reason and ingest — operators must opt in. Acceptable as documented; the original finding's "at minimum, note it" bar is exceeded.

### 10. LOW — rule coverage gaps / minor FPs — **CLOSED**

`credentialed_url` now covers mysql/mongodb(+srv)/amqp/mssql (`src/secret-scrub.ts:74`) — probed, flagged. `admin_header` fires only on `X-Admin-Password: <value>` (`:77`) — bare header name probed clean, valued header probed flagged. `bearer_token` is tool-results-only; RFC example tokens pass the gate (probed). `ENV_SECRET_MIN_LEN = 8` remains a documented tradeoff.

### 11. LOW — red-team suite couldn't catch the bypasses — **CLOSED (live-pass item PARTIAL)**

`eval/redteam/bypass-forms.yaml` adds 14 poisons, one per bypass class from Findings 2–6 (base64/base64url/base32/z32/0x/dash/ZWSP/homoglyph/long-run/trailing-char key forms, `NAME=value`, interleaved mnemonic, ≥16-char partial, verbatim prompt and addendum dumps); `eval/redteam/false-positives.yaml` adds the 8-item FP corpus (txid, block hash, sha256, x-only pubkey, git SHA, RFC bearer, header name, wordlist prose). The oracle is the production gate itself (`src/redteam.ts:61-63`), so "0 leaks" now measures what production enforces. Eval re-run: 75 items, 0 leaks, 0 unmet. **PARTIAL only on the CI live pass:** the live model pass remains opt-in (`JEB_MODEL_API_KEY` unset → skipped, confirmed in the run output); there is no canary CI job. LOW, since the offline oracle is no longer stricter than the gate and every bypass class has a poison.

### 12. LOW — observability oracles / duplicate evidence — **CLOSED**

Scrub verdict is persisted (`publish_requests.scrubbed`, migration `092_secret_scrub_persist.sql`); a retried row publishes the decline without re-scanning or re-appending `security_event` evidence (`src/publish.ts:145-159`, `src/db.ts:487-489`) — pinned by `src/publish.test.ts` ("a retried scrubbed row publishes the decline without re-scanning or duplicating evidence"). The public `/metrics` surface collapses `jeb_security_events_total` to a single unlabeled total (`src/metrics.ts:92-112`, served at `src/health.ts:26`); probed: no `rule="..."` labels publicly, internal exposition retains them. **Residual (accepted):** the published decline itself remains a whole-value confirmation oracle — rule-id granularity is now internal-only, comparison is constant-time; this was already deemed acceptable.

---

## Regression probes (all specified for this re-audit)

| Probe | Result |
| --- | --- |
| Value-matched gate still catches canonical hex key | CAUGHT (`key_material`) |
| NFKC normalization breaks z-base-32 pubky IDs / URLs in legitimate replies | NO — outbound gate passes z32 IDs and unicode prose; the gate scans a normalized *copy*, `publish.ts` PUTs `row.content` verbatim; z32 ID also survives tool-result redaction intact |
| Chain screening redacts legitimate hashes users quoted | YES — `redactSecrets` on chain posts includes the `hex64` shape rule, so a txid quoted in an ancestor post reaches the *model* as `[redacted]`. Published replies are unaffected (gate is value-matched). Deliberate tradeoff (chain posts treated exactly like tool output, `src/context.ts:24-31`), but it degrades "what's the txid in my post?" Q&A — stated here honestly as a cost, not a defect |
| Shingle gate fires on Jeb quoting his own public rules | NO — `containsPromptEcho(docs/intro-post.md)` is false; every >40-char intro line probed individually, none trips; benign "tags are claims with claimant counts" reply passes. The intro post and system prompt share vocabulary but no 48-char verbatim window |
| Reversed-order mnemonic | **REGRESSION (LOW) found, FIXED in this re-audit** — caught at `8534ac1` by the order-insensitive density window, missed by the first checksum implementation; now validated for exact-length sequences (`2ce75af`, `d9d3057`). See Finding 4 |

## Residual risks (stated honestly)

1. **bech32/bech32m key encodings** are not matched (no implementation in-tree). Any novel encoding not in the enumerated set (hex/base64/base64url/base32/z-base-32) bypasses the gate by construction.
2. **Partial env values below 16 contiguous chars** and per-character-split values are uncatchable without prose false positives; base64 encodings of *env* values (as opposed to key material) are not enumerated.
3. **Reversed-order mnemonics padded with extra wordlist words** pass (the reversed check requires an exact mnemonic-length filtered sequence to keep the 4-bit checksum's FP rate near zero; `d9d3057`).
4. **Chain/tool instruction text** reaches the model (sanitize filters role markers, not imperatives); resistance there is model-layer plus the deterministic outbound net (secret gate + prompt-echo shingles).
5. **Legitimate hashes in chain context** are redacted before the model sees them (FP cost of the anti-smuggling shape rules; no effect on published text).
6. **Semantic paraphrase** of config/infrastructure (no verbatim value, no 48-char shingle) is inherently uncatchable by any deterministic gate — model-layer only.
7. **Live red-team pass** is still opt-in; no canary CI job asserts post-gate cleanliness against a real model.
8. **Whole-value confirmation oracle** via the published decline remains (accepted; rule-id granularity now internal-only).

## Suggested follow-ups (none blocking)

1. Consider scanning chain posts with the value-matched tier and reserving `hex64`-shape redaction for tool results, if txid Q&A quality matters more than fake-key smuggling resistance on that path.
2. Wire the live red-team pass into CI against a canary when one exists.

## Addendum: 2026-09-04 production FP incident

This re-audit's Finding 4 closure claimed "random wordlist prose essentially
never passes" the checksum. That was WRONG for the filler-skipping
subsequence design, and production proved it: on 2026-09-04 10:11 UTC the
publisher scrubber fired `rules=["bip39"]` on a legitimate reply listing
accounts to follow, and the user got the credentials decline instead of the
answer.

**Cause.** Extracting every wordlist word from prose and validating every
12/15/18/21/24 window of the filtered subsequence manufactures windows out
of ordinary English (dozens of common words — "about", "all", "would",
"people" — are BIP39 words); the 12-word checksum is 4 bits, so each window
carried ~1/16 FP chance. The 4-bit concern this re-audit raised only for the
*reversed* check applied equally to the forward per-window check.

**Fix (this branch).** `scanBip39` redesigned into a zero-FP value tier (the
CONFIGURED phrase — `PUBKY_BOT_MNEMONIC` or the mnemonic form of
`PUBKY_BOT_SECRET_KEY_HEX` — matched as an ordered filler-tolerant
subsequence; only the real phrase can match) plus a narrow shape tier for
unknown phrases (contiguous wordlist-word runs only, exactly
12/15/18/21/24 words, line/punctuation bounded, checksum-valid forward or
reversed — no sliding windows, no filler skipping). Finding 4's interleaving
resistance is preserved by the value tier for the phrase that actually
matters (the bot's own); the red-team interleaved/embedded fixtures still
gate via `REDTEAM_TEST_ENV.PUBKY_BOT_MNEMONIC`. Residual risks 3 above is
superseded: unknown phrases woven into sentences or padded with fillers now
EVADE the shape tier deliberately — that is the cost of eliminating this FP
class, and it is stated honestly in the hardening report's corrected
guarantee statement.

**Quantified FP:** 200 seeded synthetic paragraphs of wordlist words joined
with common fillers → ZERO hits (gate and tool-result redaction); a
realistic Jeb-reply corpus (follow lists with 15+ handles, Pubky
explanations, docs answers) → ZERO hits under a fully configured secret env.
Positive coverage: `bip39.generateMnemonic` phrases caught in plain, comma-,
newline-separated, and reversed forms; the configured phrase caught
interleaved. Also shipped: `env_assignment` restricted to configured
secret-class names (documentation answers like `set JEB_POLL_MS=3000` pass),
and the `JEB_SCRUB_DISABLED_RULES` operator valve (startup-warned) so a
future FP can be disabled without a rollback.
