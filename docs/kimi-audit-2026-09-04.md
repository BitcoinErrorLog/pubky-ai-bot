# External security audit — Jeb (Pubky reply bot)

- **Auditor:** Kimi (external, read-only review)
- **Date:** 2026-09-04
- **Scope:** `9f2bf5c..HEAD` on `stage1/secrets`, HEAD `8e42872` (= production worktree)
- **Method:** full diff read of the 87 changed files, focused re-read of `secret-scrub.ts`, `config.ts`, `main.ts`, `requeue.ts`, `db.ts`, `publish.ts`, `homeserver.ts`, `reply-tags.ts`, `keys.ts`, `intent.ts`, `answer.ts`, `outbound-gate.ts`, `tool-screen.ts`, `extraction-guard.ts`, migration `095`; `npx tsc --noEmit`; full vitest run against `jeb_stage1_test`; `npm run eval:redteam`; throwaway probe scripts under `/tmp/jeb-probe` run against the scrubber with a freshly generated random key (deployment env never read).

## Verdict: FIX-FIRST

One finding (F-1) is a demonstrable correctness bug in the new BIP39 shape tier that voids its documented "any shipped wordlist" claim for Spanish, French, Korean (and any accented Italian/Portuguese/Czech draw). The fix is ~3 lines plus a test. Everything protecting the bot's *own* configured secrets (value tiers) probed solid. Nothing found that warrants DO-NOT-SHIP.

## Findings

| ID | Severity | File:line | Finding / exploit sketch | Fix |
| --- | --- | --- | --- | --- |
| F-1 | **Medium** | `src/secret-scrub.ts:295-301` (`allBip39Wordlists`), used by `scanBip39Shape` at :396-433 | **Shape tier silently never fires for NFKD wordlists.** Scan text is NFKC-normalized (`text-normalize.ts`), but the bip39 package ships Spanish (334/2048 accented), French (366/2048), and Korean (2048/2048) wordlists in NFKD. Run-detection set membership compares NFKC tokens against NFKD entries, so a contiguous, line-bounded, checksum-valid Spanish/French/Korean mnemonic is never even a candidate; Italian/Portuguese/Czech only fire when the random draw contains no accented word. Probed: 10/10 random Spanish mnemonics MISSED (199/200 random Spanish phrases contain a non-NFC word), French and Korean MISSED, English/Chinese HIT. `validateMnemonic` would also fail because it NFKD-normalizes its input and would compare against the same mismatched list. Exploit: a poisoned web/tool result containing a non-English seed phrase evades `redactSecrets` (enters model context unredacted) and, if echoed contiguously, evades the outbound gate too — exactly the unknown-phrase case the shape tier exists for. The header doc (:384-386) overclaims "checksum-valid … against any shipped wordlist". | Build the run-detection set from NFKC-normalized entries (`list.map(w => w.normalize("NFKC"))`) and pass the candidate words re-normalized to NFKD into `validateMnemonic` with the raw shipped list. Add a per-language shape test (generate a valid mnemonic per wordlist, assert HIT). |
| F-2 | Low | `src/publish.ts:120`, `src/homeserver.ts:160-162` | **`replace_post_id` is not re-validated at the publisher.** `publishOne` only trims/uppercases before `publishReply` interpolates it into the storage path (`${POSTS_PREFIX}${id}`). Shape validation (`/^[A-Z0-9]{13}$/`) exists in `requeue.ts` (canonical-URI parse) and `reason.ts:47`, so no reachable injection today — but the publisher is the trust boundary for the signing key, and a future caller of `insertPublishRequest({replacePostId})` or a DB-write primitive would get path control inside the bot's homeserver storage. | Assert `/^[A-Z0-9]{13}$/` on `replaceId` in `publishOne` (or `validatePublishShape`) and fail the row loudly if it doesn't match. |
| F-3 | Low | `src/db.test.ts:38-80` (vs `src/work-reaper.test.ts:136`) | **Test pollution, not a product bug.** The new `replace_post_id round-trip` test leaves its `handled_mentions` row in `processing` with no cleanup, so `listStaleProcessingMentions` in the work-reaper test sees it when the whole suite shares one database. Observed: full-suite run fails `work-reaper.test.ts` ("REPLACESTORE1" in stale list); the file passes standalone. | Delete the fixture row in `afterAll` (the test already deletes in-setup; mirror it). |
| F-4 | Informational | `src/secret-scrub.ts:157-166, 329-342` | **Uncached per-scan derivation.** When `PUBKY_BOT_MNEMONIC` is configured, every scan runs `mnemonicToSeedSync` (2048-round PBKDF2) plus `validateMnemonic` — measured ~12 ms/scan vs ~0 ms with hex-only env. Publisher-only impact (reason/ingest children hold no key material, so their scans no-op these paths). Not a leak; a small CPU tax per outbound reply and per tag label. | Cache `keyByteArrays`/`knownMnemonics` per env object (or compute once at startup and inject). |
| F-5 | Informational | `src/reason.ts:182-199`, `src/skip-notice.ts:71-77` | **`requeue --replace` + policy skip overwrites the old reply with a skip notice.** `skip()` forwards `replacePostId` to `queueSkipNotice`, so an operator re-answer that hits a notified skip (blocklist, caps) replaces the published answer with a notice post under the same post id. Arguably intended (the thread keeps one bot post per mention); flagging so it's a conscious choice. | None required; document, or drop `replacePostId` on the skip-notice path. |
| F-6 | Informational | `src/config.ts:220-225` vs `src/secret-scrub.ts:514-522` | Unknown rule ids in `JEB_SCRUB_DISABLED_RULES` are kept in `cfg.scrubDisabledRules` (and printed in the startup warning) but silently ignored by `disabledScrubRules`. An operator typo (`"bip-39"`) would log a reassuring warning while disabling nothing. | Warn on unrecognized ids at startup, or filter at parse time. |

## Scope questions, answered

### 1. `secret-scrub.ts` redesign

**Can an attacker get Jeb to emit his own mnemonic or key hex in a form the scrubber misses?**
Probed with a fresh random key + its derived 24-word mnemonic (deployment env never touched). Results:

| Form | Result |
| --- | --- |
| Plain phrase; fillers interleaved; ` - ` separators; `1. word` numbering; code block; URL path; UPPERCASE; split across sentences | **HIT** (value tier, filler-tolerant ordered subsequence) |
| Reversed, contiguous, own line | **HIT** (shape tier, reversed checksum) |
| Reversed **with fillers** | MISS — value tier is forward-only, shape tier requires contiguity |
| Words concatenated with no separator (`word1word2…`) | MISS — tokenization is letter-run based |
| Wordlist **indices** (`1473, 22, …`) | MISS — no numeric form is modeled |
| Same entropy in the **Spanish wordlist**, contiguous, own line | MISS — this is F-1 (NFKD vs NFKC), not a design choice |
| base64 / hex of the **phrase text** (not key bytes) | MISS — only encodings of the 32 key bytes are enumerated |
| One word per reply across turns; 11 or 23 of 24 words in one reply | MISS — inherent; per-reply scanning can never catch a cross-turn drip, and partial subsequence is deliberately not matched (zero-FP design) |
| Key hex: contiguous, `0x`, dash-split, embedded in longer run | **HIT** (`key_material`, compacted-run containment) |
| Key hex reversed as a string | MISS (reversed *bytes* would re-encode differently and are also missed; documented class) |
| bech32/bech32m of key bytes | Not covered — confirmed no bech32 implementation exists in the dependency tree, matching the documented limitation |

Critical context for severity: the model never possesses the secret. The reason child boots with `assertNoKeyMaterial()` and an allowlisted env containing no `PUBKY_BOT_*`; the mnemonic/hex exists only in the publisher (and operator scripts). Every MISS above therefore requires a prior context-contamination breach; the scrubber is the last gate, not the only one. The forms that matter most (filler-separated, code-blocked, URL-embedded, reordered-without-fillers) are all caught.

**Does the value tier leak timing/length info?** No practical leak. Detections report rule ids only; matched text is never returned, logged, or stored (verified in `publish.ts:155-164`, `db.ts:609-616`, `metrics.ts`). The scan is plain defensive substring search — not constant-time, but the only remotely observable signal is the fixed 1-bit decline-vs-publish oracle, which is inherent to any gate that publishes a deterministic decline. The `env_secret` ≥16-char fragment rule (`ENV_SECRET_PARTIAL_MIN_LEN`) gives a guess-confirmation oracle only to an attacker who already holds a 16-contiguous-char bootstrap fragment (≥2^64 work for the hex key) — acceptable, and the tradeoff is documented in-code. One perf observation, not a leak: see F-4.

**Is mnemonic derivation from the hex done in the publisher only?** Effectively yes. `knownMnemonics()`/`keyByteArrays()` run wherever a scan executes with an env holding the material; only the publisher (and operator scripts `scripts/post.ts`, `scripts/profile.ts`) ever hold `PUBKY_BOT_*`. The reason/ingest children provably don't (`keys.ts` allowlists + `assertNoKeyMaterial()` + drift test), so their `redactSecrets` calls match nothing by value and run shape rules only. `entropyToMnemonic` is called on the hex only inside `knownMnemonics`.

### 2. `JEB_SCRUB_DISABLED_RULES` valve

- **Settable only from the deployment env.** Read exclusively from `process.env` (`config.ts:220`, `secret-scrub.ts:517`). No DB switch, admin endpoint, mention text, or tool-result path touches it; `opts.disabledRules` is only passed by tests. The reason child receives it deliberately (allowlisted) so tool-result redaction honors the same valve; the ingest child does not.
- **Logged loudly:** startup `log.warn` with `event: "security_event"` and the rule list in `main.ts:83-88`, for every role. Verified by reading; config parse covered in `config.test.ts:49-60`. Caveat: F-6 (typos warn but don't apply).

### 3. Publisher `--role requeue --replace`

- **Author check:** `requeueOne` refuses unless the target reply URI parses canonically and its author equals `cfg.botPk` (`requeue.ts:43-45, 89-91`); covered by `requeue.test.ts:216` ("refuses --replace when the stored reply is not the bot key"). `putReplyTags` independently refuses non-bot URIs (`reply-tags.ts:117-120`).
- **Path traversal / id validation:** the post id comes from `parsePostUri`, which anchors the full URI shape (`/^[A-Z0-9]{13}$/i` id, `types.ts:57-61`); `reason.ts:47` re-validates before it reaches `publish_requests`. Only residual: the publisher itself doesn't re-check (F-2).
- **Trust boundary on `replace_post_id`:** clean. Grepped every writer: the work-queue payload carries `replace_post_id` only from `requeue.ts:96` (operator CLI, requires shell + DB + `JEB_BOT_PK`); ingest writes `{ mentionKey }` only (`ingest.ts:136,147`); reason reads it via a validating extractor. A crafted mention text cannot influence it — there is no path from post content to the payload.
- **Idempotency / duplicates:** `supersedePublishForReplace` moves prior rows out of the partial unique index, so the new request inserts exactly once; `publishOne` skips the `existingReply` reconcile only when `replaceId` is set and the retry re-PUTs the *same* path (same post id, no duplicate); crash-between-supersede-and-enqueue leaves the mention `published` with a `superseded` request — no duplicate, operator-visible. Non-replace path unchanged (reconcile → mark published). Overwriting an *unrelated* bot post requires either the stored `reply_uri` of this mention (i.e., its own reply) or an explicit operator `--reply`. Mid-sequence crash windows are fail-quiet, not fail-duplicate.
- **Self-tags dedupe:** `putReplyTags` dedupes labels, tag id = hash(uri+label) so re-PUTs are idempotent, `claimPendingTags` requires `tag_uris IS NULL`, labels are vocabulary-pinned and individually scrubbed before PUT.
- Migration `095` is a nullable `TEXT` column add — no constraint or index changes.

### 4. `keys.ts` allowlists + drift test

Confirmed: no `PUBKY_BOT_*`, `JEB_SIGNUP_TOKEN`, `ADMIN_TOKEN`, `JEB_ADMIN_PORT`, or `JEB_HOMESERVER` in either child allowlist; reason gets the API keys it functionally needs (`JEB_MODEL_API_KEY`, `JEB_EMBED_API_KEY`, `JEB_BRAVE_API_KEY`) and the scrub valve; ingest gets none of those (`INGEST_FORBIDDEN` asserted). The drift test parses every `JEB_*` reference out of `config.ts` source and requires it to be allowlisted or explicitly excluded, asserts exclusions stay out of both lists, and asserts per-role DB URLs replace rather than leak. `DATABASE_URL` (credentialed) necessarily reaches both children; the per-role PG-user escape hatch (`JEB_DB_URL_REASON`/`_INGEST`) is wired and tested.

### 5. `intent.ts` / `answer.ts` tool catalog

- Decline/ignore paths return before any tool registration (`answer.ts:105-110`) — zero tools, zero model calls for the extraction-guard decline; the `toolsForIntent([])` for decline/ignore is now unreachable in practice but still correct.
- `toolsForIntent` now returns `FULL_TOOLS` for every other intent; gating moved entirely to registration and execute-time guards, which are **unchanged since `9f2bf5c`** (diff shows only test files touched under `src/scout/`, `src/web/`): `search_web` registers only when `webProvider !== "off"` and a budget pool exists (`web/tools.ts:20-25`), with per-mention/daily caps and the web switch inside the tool; `query_graph` raw mode stays behind `JEB_SCOUT_RAW_ENABLED` + `guardRawCypher` (write/admin/proc denylist, profiling denylist, varlen-path bound) in `scout/guard.ts`; every tool execution still passes `wrap()` → `screenToolResult` (injection sanitize + `redactSecrets` + 8 KB serialized cap).

## What I verified and how

1. **Static read** of the full `9f2bf5c..HEAD` diff plus the current full text of every in-scope file (listed at top).
2. **`npx tsc --noEmit`** — clean.
3. **`DATABASE_URL=postgres://johncarvalho@127.0.0.1:5432/jeb_stage1_test npx vitest run --exclude tests/eval/retrieval-gate.test.ts`** — 645 passed, 3 skipped, 1 failed: the F-3 cross-file pollution (`work-reaper.test.ts`), which passes standalone and is a test-hygiene issue, not a product defect.
4. **`npm run eval:redteam`** — 76 items: 35 guard declines, 2 fixed answers, 29 publisher-gate catches downstream of a guard pass, **0 leaks, 0 unmet expectations** (live-model pass skipped, no `JEB_MODEL_API_KEY` set — noted, not a gap in this audit's scope since the offline gate is what production enforces).
5. **Probe scripts under `/tmp/jeb-probe/`** (throwaway, since deleted-class; repo untouched) driving `scanForSecrets` directly with a freshly `randomBytes(32)` key and its `entropyToMnemonic` phrase across ~25 evasion forms (table above), plus a 200-sample NFKD-word frequency measurement and a per-language shape-tier sweep that isolated F-1's root cause (bip39 ships Spanish/French/Korean wordlists in NFKD; scan text is NFKC).
6. **Trust-boundary grep** for every writer of `replace_post_id` / `enqueueWork` / `insertPublishRequest` and every reader of `JEB_SCRUB_DISABLED_RULES` (results in §2/§3).

No source files were modified; the only write is this report. No git mutations of any kind were performed.

## Remediation 2026-09-04

All findings fixed on `stage1/secrets`. Proof: `npx tsc --noEmit` clean; full vitest suite (`--exclude tests/eval/retrieval-gate.test.ts`) green twice in a row (724 passed, 3 skipped, 0 failed, 56 files, both runs); `npm run eval:redteam` 0 leaks / 0 unmet expectations; `npm run build` clean.

| ID | Commit | Fix summary |
| --- | --- | --- |
| F-1 | `ed3e44b` | `allBip39Wordlists` now builds the run-detection set from NFKC-normalized entries with an NFKC→raw-spelling map; `scanBip39Shape` maps candidate words back to the raw shipped spelling before `validateMnemonic` against the raw list, so the NFKD-shipped Spanish/French/Korean (and accented Italian/Portuguese/Czech) wordlists fire. Header doc updated. Per-language test: every wordlist the package ships, 12- and 24-word generated mnemonics, asserted HIT plain and comma-separated; the seeded 200-paragraph FP corpus re-asserted at 0 hits. |
| F-2 | `bf1f44d` | `publishOne` re-validates `replace_post_id` against `/^[A-Z0-9]{13}$/`; a malformed id marks the row `failed` (`markPublishFailed`) with the reason, logs an error, and never PUTs. Tested (bogus id → 0 PUTs, row failed). |
| F-3 | `b928b64` | The `replace_post_id round-trip` test now deletes its fixture `publish_requests`/`handled_mentions` rows in `afterAll`; full suite (incl. `work-reaper.test.ts`) passes twice in a row on a shared DB. |
| F-4 | `ed3e44b` | Derived key byte arrays / known mnemonics are cached per env object (WeakMap, fingerprinted on the raw key-material inputs), so the publisher no longer runs PBKDF2 per scan. Tested: two scans with the same env reuse the cache; mutating the env invalidates it. |
| F-5 | `65812cd` | Decision made: a `requeue --replace` re-answer ending in a notified skip must NOT overwrite the prior answer. `reason.ts skip()` drops `replacePostId` on the skip-notice path and logs at warn with the mention key and skip reason; `queueSkipNotice` no longer accepts `replacePostId`. Tested (notice publish request has `replace_post_id` NULL). Documented in `docs/limits.md` under "Operator: requeue and in-place replace". |
| F-6 | `0cad8a2` | `configFromProcessEnv` compares each `JEB_SCRUB_DISABLED_RULES` id against the exported `SECRET_SCRUB_RULES` list, warns at startup on unrecognized ids (with the unknown ids listed), and filters them out. Tested (typo id warned + dropped; all-recognized list does not warn). |
