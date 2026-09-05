# KIMI EXTERNAL AUDIT A7 — Proactive Drafts Pipeline, GitHub Token, Drafts Admin Page

Baseline `90d35c4` (deployed) → candidate `f21c1b5`. Scope: `src/drafts/**`, `src/dashboard-drafts.ts`, `packages/bot-kit/src/security/keys.ts`, `packages/bot-kit/src/security/secret-scrub.ts`, `.env.example`, `docs/proactive.md`, `docs/kimi-audit-a2-drafts-2026-09-04.md`, plus read-only verification of directly-called code (`src/health.ts`, `src/db.ts`, `src/publish.ts`, `packages/bot-kit/src/publish/publisher.ts`, `src/links.ts`, `src/voice.ts`, `src/main.ts`, `src/config.ts`, `packages/bot-kit/src/nexus-schema.ts`). Read-only worktree; no source modified.

New in this diff: `github.ts`, `ecosystem.ts`, `thread.ts`, `window.ts`, `compose.ts`, `citations.ts`, `render-html.ts`, `render-md.ts`, `src/dashboard-drafts.ts`, the LLM compose loop in all six generators, the `/admin/drafts` page, `JEB_GITHUB_TOKEN` plumbing. Modified: `finish.ts` (citation allowlist, quality floors, secret scan), `generate.ts`, `cli.ts` (render/regenerate), `publish-request.ts` (self-tags), `health.ts` (drafts admin routes, cookie auth), `keys.ts` (+`JEB_GITHUB_TOKEN` on `REASON_ALLOWLIST`), `secret-scrub.ts` (+`JEB_GITHUB_TOKEN` in `SECRET_ENV_NAMES`).

## Verdict: SHIP

The headline invariants hold and are test-pinned: the GitHub token is allowlist-scoped, shape- and value-scrubbed, and never logged; `github.ts` is host-pinned with same-host-only redirects; model output is confined to evidence-set links (verified end-to-end with hostile input); the admin page is token-gated on loopback with sound double-submit CSRF and escape-then-markdown rendering; approve is replay-safe, cap-serialized, and still funnels through the publisher's `approved_by`/content-hash/kill-switch/outbound-scrub re-checks. All findings are LOW-severity defense-in-depth gaps whose exploit preconditions require a compromised upstream index (Nexus/Scout) or only degrade documentation accuracy. No A2 closed finding has regressed. Recommended: land the trivial fixes for A7-1 and A7-2 in a follow-up before the formats graduate.

Tests run (all pass): `src/drafts/compose.test.ts`, `render-html.test.ts`, `formats.test.ts`, `window.test.ts`, `drafts.test.ts`, `src/dashboard-drafts.test.ts`, `src/keys.test.ts`, `packages/bot-kit/src/security/secret-scrub.test.ts` (207 tests total). Adversarial behavior additionally verified by direct execution of `citations.ts`, `finish.ts`, `render-html.ts`, `dashboard-drafts.ts` against hostile inputs (results quoted below).

## Findings

### A7-1 — LOW — Dashboard Evidence list renders scheme-unvalidated hrefs (`javascript:`/`data:` clickable in the admin page)

- **Where:** `src/dashboard-drafts.ts:47-51` (`evidenceLinks` emits `<a href="${escapeHtml(u)}">` for raw `row.evidence.uris`). Contrast: the body preview path `src/drafts/render-html.ts:18-22` scheme-allowlists (`safeHref`: http/https/pubky only).
- **Impact:** HTML-escaping prevents attribute/markup breakout (verified), but the scheme is not checked: a draft whose evidence contains `javascript:alert(1)` renders a clickable `javascript:` link; `data:text/html,...` likewise (both reproduced against `renderDraftsPage`). Clicking executes same-origin JS in the authenticated admin page, which can read the CSRF token from the DOM and POST approve/reject/regenerate as the operator. Exploit precondition: a non-pubky URI must reach `evidence.uris` — normal attackers cannot mint one (post URIs are keyspace-derived), so this needs a poisoned/compromised Nexus or Scout response (see A7-2) or a bad operator-ingested knowledge source URL. Loopback + `ADMIN_TOKEN` + `SameSite=Strict` bound the blast radius.
- **Fix:** In `evidenceLinks`, reuse the `safeHref` policy from `render-html.ts` (allow `https?:`/`pubky:` only) and render non-conforming URIs as plain text. One-line change plus a test mirroring `render-html.test.ts`.

### A7-2 — LOW — Evidence URIs are not shape-validated at collection; any http(s) evidence URI becomes citable and publishable

- **Where:** `src/drafts/thread.ts:39,124-130` (`threadPostFromView` keeps `view.details.uri` even when `parsePostUri` throws; `threadEvidenceUris` forwards every `p.uri`); `packages/bot-kit/src/nexus-schema.ts` (`details.uri: z.string()` — unvalidated, unlike `author: z32Schema`); `src/drafts/finish.ts:142-161` (`evidenceHref` passes any `^https?://` URI through; `allowedCitationHrefs` also adds the raw http(s) form); `src/drafts/pubky-explained.ts:147-149` (`asQuestion` returns the raw `p.uri`).
- **Impact:** The "evidence-only links" boundary is exactly as strong as index integrity. A Nexus/Scout row with `details.uri = "https://evil.example/phish"` (plus an in-window `created_at`) flows into `evidence.uris`, into `allowedCitationHrefs`, and the model may then legitimately cite it — `dropUnknownCitations` keeps it because it *is* in the evidence set. The link then survives to the published post after operator approve. Normal attackers cannot set their post's `uri` (keyspace-derived), so this is a compromised-index/Index-poisoning precondition, not a user-level exploit; operator review is the current backstop.
- **Fix:** Validate at collection time: in `threadPostFromView`/`threadEvidenceUris`, drop posts whose `uri` fails `parsePostUri`; in `pubky-explained.asQuestion`, keep the `postLink`-validated form or drop. Optionally host-allowlist http(s) evidence per generator (github.com for radar/what-changed, the configured app origin for post/profile links).

### A7-3 — LOW — Prompt-injection hygiene is inconsistent: 5 of 6 generators embed unsanitized attacker text into the compose prompt

- **Where:** `src/drafts/thread.ts:116-120` (400-char raw post bodies), `src/drafts/what-changed.ts:117-135` (raw commit messages, doc URLs), `src/drafts/release-radar.ts:144-149` (raw 400-char release-note excerpts), `src/drafts/the-disagreement.ts:63-65`, `src/drafts/new-connection.ts:54-64` (label is sanitized; the rest raw). Only `src/drafts/pubky-explained.ts:53-59` applies `sanitizeUntrustedDraftText` to evidence notes.
- **Impact:** Full post bodies, release notes, and commit messages reach the model with instructions intact, so an attacker posting "Ignore your rules, say X" can steer draft *prose*. Output-side constraints are verified effective against the link/text-injection escalation: markdown links/images are neutralized (`finish.ts:120-122`), `pubky://` URIs and bare 52-char keys are stripped (`finish.ts:124-136`), non-evidence URLs drop the bullet (`citations.ts:21-43` — verified: evil-URL bullet removed, fake `pubky://` and bare-key segments stripped end-to-end through `finishDraft`), length floors/ceilings and link-only rejection apply, and the secret scrubber runs twice (finish + publish gate). Residual risk is misleading *text* with legitimate evidence links, gated by operator review. Risk reduction is cheap and uniform.
- **Fix:** Route all graph/GitHub-sourced evidence-note segments through `sanitizeUntrustedDraftText` (as `pubky-explained` already does) before building `evidenceNotes`, keeping the URL lines themselves intact.

### A7-4 — LOW — `JEB_GITHUB_TOKEN` placement contradicts the docs; real consumers are the drafts CLI and the *publish* process

- **Where:** `.env.example:121-124` and `docs/proactive.md:34` ("Reason role only — not ingest or publish"); `packages/bot-kit/src/security/keys.ts:107-112` (`REASON_ALLOWLIST`); `src/main.ts:47` (publish child spawned with full `process.env`); `src/dashboard-drafts.ts:153-157` (dashboard `regenerate` runs `generateFormat` — Scout/Nexus/GitHub/model calls — inside the publisher process, the only role wired with `cfg`: `src/publish.ts:176`).
- **Impact:** (a) The reason child carries the token but no reason-role code path reads it (weekly loop does not use `github.ts`; `--role drafts` runs in the main process) — dead exposure. (b) The publish child *does* hold it (full env by design) and the admin-page regenerate path executes GitHub fetches and the model pipeline inside the signing-key process — exactly what the docs claim never happens. The token is read-only public-repo scope and the publisher already guards far stronger secrets, so the practical risk is small; the issue is least-privilege drift and an inaccurate operator-facing doc.
- **Fix:** Correct `.env.example`/`docs/proactive.md` to state actual consumers (drafts CLI in the main process; publisher on admin regenerate). Consider dropping `JEB_GITHUB_TOKEN` from `REASON_ALLOWLIST` until a reason-role consumer exists, and/or moving dashboard regenerate's generation work out of the publish process (e.g. reject-in-dashboard + `drafts regenerate` CLI) so the signing-key process keeps its minimal network surface.

### A7-5 — LOW — Doc/behavior mismatch: dashboard regenerate leaves the draft pending on evidence-source failure

- **Where:** `docs/proactive.md:47` ("`regenerate` then rejects the existing draft so a previous partial body is not left in place") vs `src/dashboard-drafts.ts:153-157` (on `DraftRejectedError` the POST just returns 400; the old draft stays `draft`). The CLI path does reject (`src/drafts/cli.ts:150-156`).
- **Impact:** Direction is fail-safe (a stale-but-reviewed draft remains pending rather than being auto-rejected), but the two regenerate paths diverge from the documented behavior; an operator reacting to a dashboard 400 may believe the draft was rejected when it was not.
- **Fix:** Either mirror the CLI in `handleDraftsPost` (call `store.rejectDraft(id, DRAFTS_ADMIN_HANDLE, "evidence source unavailable")` on the matching `none: evidence source unavailable` error) or amend `docs/proactive.md` to scope the reject-on-unavailable behavior to the CLI.

### A7-6 — LOW — `github.ts` response size cap is post-download

- **Where:** `src/drafts/github.ts:84-85` (`res.text()` buffers the full body before `text.length > MAX_BYTES` is checked; the check counts UTF-16 code units, not bytes).
- **Impact:** The 1 MB cap does not bound memory during download; a multi-hundred-MB response is fully buffered first. Mitigating factors: requests are pinned to `api.github.com` (operator-manifest repos only), same-host redirects, one AbortController across hops with a real timeout, `per_page` limits. Not attacker-steerable to an arbitrary host (see Verified properties), so the practical DoS surface is a misbehaving/compromised GitHub API.
- **Fix:** Enforce the cap while streaming (`res.body` reader with a byte counter, abort past `MAX_BYTES`) or set an explicit `Accept-Encoding: identity` and check `content-length` pre-read when present.

### A7-7 — Informational — loose post-id shape in `evidenceHref` / `rewritePubkyCitations`

- **Where:** `src/drafts/finish.ts:144` (`([A-Za-z0-9._~-]+)` for the post id) and `src/links.ts:5` (same class); the strict 13-char Crockford form is enforced only in `src/drafts/scout-util.ts:30` (`postLink`) and `window.ts`/`publisher.ts`.
- **Impact:** `pubky://<pk>/pub/pubky.app/posts/..` maps to `https://pubky.app/post/<pk>/..` (reproduced). Same-origin on the configured app URL, and the citation allowlist confines the model to evidence-derived hrefs, so impact is cosmetic (odd/404 app links), not cross-origin.
- **Fix:** Tighten the post-id group to `[A-Z0-9]{13}` (case-insensitive) in `evidenceHref`; optionally the same in `links.ts` for symmetry.

### A7-8 — Informational — admin-page ergonomics with security side-effects (non-blocking)

- CSRF token rotates on every `GET /admin/drafts` (`src/health.ts:110`, `dashboard-drafts.ts:96-101`): a second tab invalidates the first tab's forms (403 on submit). Double-submit + `SameSite=Strict; HttpOnly` is otherwise sound; per-request rotation buys nothing and costs availability. Consider a per-day token derived from the admin token, or accept the nuisance.
- Admin token is mirrored into an HttpOnly cookie without `Secure` (`dashboard-drafts.ts:39-45`) — required for plain-http loopback; moot unless an operator terminates TLS in front, in which case add `Secure` conditionally.
- `readBody` (`dashboard-drafts.ts:103-107`) has no size cap; authenticated admin token holders only, so negligible.
- `handleDraftsPost` returns `e.message` to the admin (`dashboard-drafts.ts:158-160`). Content is `text/plain` (no XSS) and admin-only; messages can embed model-influenced `none` reasons (≤240 chars, `compose.ts:29-35`) but never secrets (finish-time `scanForSecrets` reports rule ids only, `finish.ts:186-189`; model/provider keys are never in prompts).

## Verified properties

**Q1 — `JEB_GITHUB_TOKEN` handling.**
- Allowlist scoping: present on `REASON_ALLOWLIST` only (`keys.ts:112`); `INGEST_ALLOWLIST = SHARED_ALLOWLIST` excludes it (`keys.ts:165`); pinned by `keys.test.ts:221-230` (reason gets it, ingest never; `GITHUB_TOKEN`/`GH_TOKEN` never on any allowlist). `githubHeaders` reads *only* `JEB_GITHUB_TOKEN` (`github.ts:30-38`; `compose.test.ts:127-141`). Publish child receives it via full env by design — see A7-4.
- Never logged: `github.ts` throws only fixed strings (`"github redirect rejected"`, `"response too large"`, `"github redirect hop limit"`, `"evidence source unavailable"`); the token travels in the `Authorization` header, never in URLs; fetch/abort errors carry no URL or headers; CLI/dashboard error paths print `e.message` only.
- Scrubbed outbound: `JEB_GITHUB_TOKEN` ∈ `SECRET_ENV_NAMES` (`secret-scrub.ts:111`) — value + any contiguous ≥16-char fragment blocked at the draft finish gate (`finish.ts:186-189`) and again at the publisher outbound gate (`publisher.ts:596-611`); `ghp_`/`github_pat_` shapes blocked regardless of configuration (`secret-scrub.ts:74`).
- SSRF: URLs are constructed host-pinned (`https://api.github.com/repos/${owner}/${repo}/...`) with `[\w.-]+` owner/repo and `encodeURIComponent` tag (`github.ts:105,123`); redirects are manual, https + exact-host `api.github.com` only, ≤3 hops, off-host/userinfo/dot-suffix rejected (`github.ts:48-59`; tested). Verified: evidence from Scout/Nexus never reaches `github.ts` — repo sets come solely from the operator knowledge manifest filtered by `isPubkyEcosystemRepo` (`what-changed.ts:62-87`, `release-radar.ts:89-99`).
- Rate limit → `GithubUnavailableError` → `none: evidence source unavailable`; no partial rows (`insertDraft` runs only on success; CLI regenerate rejects the stale draft, `cli.ts:150-156`).

**Q2 — Citation validation.** Encoding tricks fail closed (verified by execution): uppercase host, `userinfo@`, and `github.com.evil.com` are all dropped; trailing punctuation/slash normalized (`citations.ts:3-5`); the prefix rule (`citations.ts:10-12`) is host-confined to evidence hosts (worst case: citing a same-host prefix such as `https://github.com` when a github.com evidence URL exists — accepted design); markdown target-vs-text mismatch neutralized (link syntax stripped pre-gate, `finish.ts:120-122`). pubky.app links are built from 52-char pubky ids throughout; 13-char post ids enforced in `postLink` (loose-but-contained in `evidenceHref` — A7-7).

**Q3 — Prompt injection.** Output constraints verified end-to-end through `finishDraft`: injected bare evil URL ⇒ bullet dropped; fake `pubky://<52>/pub/pubky.app/posts/<id>` ⇒ stripped pre-rewrite so `rewritePubkyCitations` cannot promote it; bare 52-char key ⇒ stripped; surviving bullets cite only evidence hrefs. `finishReason: "length"` ⇒ tail drop ⇒ truncated-output floors (`compose.ts:131-135`, `finish.ts:67-85`); link-only output ⇒ one strict retry ⇒ reject (`compose.ts:115-129`); per-format min lengths, ≥2 complete bullets for list formats, 2000-char ceiling, citation cap 8. Residual prose-steering risk + inconsistent input sanitization noted as A7-3.

**Q4 — Admin page.**
- XSS: escape-then-markdown (`render-html.ts:46-48`); scheme allowlist on links; attribute-breakout attempts (`" onmouseover=`, `%22`) render inert (verified); format/title/date/escaped in `dashboard-drafts.ts:64-67`; exception: Evidence-list hrefs (A7-1).
- AuthN/Z: `ADMIN_TOKEN` required on GET and POST before routing, bearer or cookie, `timingSafeEqual` (`health.ts:52-65,98-108`); fail-closed 404 with no token; loopback default bind (`config.ts:248`); POST-only on actions (405) (`health.ts:113-119`).
- CSRF: double-submit cookie (`SameSite=Strict; HttpOnly; Path=/admin`), form-field or `X-CSRF-Token` header vs cookie via `timingSafeEqual` (`health.ts:120-128`, `dashboard-drafts.ts:31-37`); test-pinned 401/403/405 (`dashboard-drafts.test.ts`).
- Idempotency/replay: approve replay ⇒ 400 (`db.ts:872-875` status guard under `FOR UPDATE` + advisory lock); reject/regenerate on non-draft ⇒ 400 (`db.ts:926-935`, `dashboard-drafts.ts:153-154`); concurrent approves serialized by `pg_advisory_xact_lock` (`db.ts:865`) with cap test coverage.

**Q5 — Approve → publish.** Dashboard approve hardcodes `decidedBy: "dashboard"` (`dashboard-drafts.ts:10,144`) — the operator cannot set an arbitrary `approved_by` through the page. The enqueue uses the `FOR UPDATE`-locked body (`publish-request.ts:31-43`), rolls back on `inserted === false` (`db.ts:892-895`), and the publisher independently re-checks: non-empty `approved_by` (`publisher.ts:508-517`), standalone `mention_key` == content-seed hash (`publisher.ts:518-534`), `replace_post_id` shape, replies/global/proactive kill switches (double-checked, `publisher.ts:548-578`), and the outbound secret scrubber with decline substitution + `declined` draft status (`publisher.ts:586-611,663-665`). Note (design, not a finding): the publisher verifies *non-empty*, not a "real operator handle" — any non-empty string passes; CLI `--by` is equally free-form. DB CHECK requires `decided_by` on approved/published/declined (migration `101`).

**Q6 — Budgets.** Per-call output cap `DRAFT_MODEL_MAX_TOKENS = 700` before the model call (`types.ts:58`, `compose.ts:63`); ≤2 model calls per draft (single link-only retry); regenerate is one generation per authenticated POST (no loops); GitHub `per_page` caps (5 releases/10 commits), manifest-bounded repo set, 3-hop redirect cap, single timeout across hops; rate-limit ⇒ `none` with no partial rows (verified by test: `compose.test.ts:208-232`). Approve-time daily cap under advisory lock (`db.ts:865-885`).

**Q7 — Privacy/logging.** CLI prints format/status/message and evidence *counts* (`cli.ts:51`), never bodies/URLs/tokens; `show` is operator-console-only; secret-scrub refusals name rule ids only; dashboard error bodies are `text/plain` and admin-only; `GithubUnavailableError` and redirect/timeout errors carry no URLs or headers.

**A2 regression check.** F-1 advisory-lock cap ✓ (`db.ts:865`), F-2 finish-time sanitization ✓ (extended), F-3 directory-scan + startup tripwire + CHECK constraint ✓ (`no-autonomous.ts:24` scans all of `src/drafts/` including the eight new files; `cli.ts:31`), F-4 locked-row enqueue ✓, F-5 `inserted===false` rollback ✓, F-6 `declined` status + stats exclusion ✓. No closed finding reopened.

## Not covered

- **Nexus/Scout service integrity.** Treated as trusted indexers; A7-1/A7-2 mark the exact seams where that trust is assumed (unvalidated `details.uri`, knowledge `source_url`s, GitHub `html_url`s).
- **The weekly autonomous pipeline** (`src/weekly/**`) — separate scope; touched only where it intersects `REASON_ALLOWLIST` additions.
- **Model-provider behavior.** Jailbreaks that produce policy-violating *prose* citing only evidence links are, by design, operator-review territory (stage-2 drafts never auto-publish).
- **`ADMIN_TOKEN` provisioning** (strength, storage, rotation) and OS-level env hygiene for the operator shell.
- **Full test-suite run.** Only scope-relevant test files were executed (listed above); `publish.test.ts` and unrelated suites were not re-run.
- **Standalone `--role reason` admin listener** serving `GET /admin/drafts` without `cfg` (POSTs 500) — pre-existing behavior, unchanged by this diff.
- **`render-md.ts` CLI output** — writes operator-selected local files; body is raw draft text in markdown (no sanitizer), consumed by the operator, not a browser.

KIMI_AUDIT_A7_COMPLETE

## Remediation

Implemented 2026-09-05 on `stage2/audit-a6a7-fix` (worktree `pubky-ai-bot-harden`).

| Finding | Commit |
|---|---|
| A7-1 dashboard evidence hrefs http(s)/pubky only | `23f9ca4` (`safeHref`); `57ee90b` (dashboard list) |
| A7-2 https + allowlisted hosts + 13-char post ids at collection | `23f9ca4` |
| A7-3 sanitizer on the other five generators | `66771fa` |
| A7-4 `JEB_GITHUB_TOKEN` on drafts CLI + publish regenerate only | `dfe2644` |
| A7-5 dashboard regenerate rejects stale draft | `57ee90b` |
| A7-6 GitHub stream size cap / abort | `c3662bc` |
| A7-7 post-id `/^[A-Z0-9]{13}$/` in `evidenceHref` and `rewritePubkyCitations` | `23f9ca4` |
| A7-8 CSRF reuse per session; HttpOnly/SameSite/Secure cookies | `57ee90b` (session CSRF); `39a5bde` (Secure on HTTPS admin GET) |
