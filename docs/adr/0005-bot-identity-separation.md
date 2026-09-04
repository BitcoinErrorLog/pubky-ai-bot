# ADR 0005: Bot identity separation

**Status:** Proposed — John accepts  
**Date:** 2026-09-04  
**Open question:** Robots §13 Q6 (`rise-of-the-robots.md` §13 item 6); plan §6.2, §6.5, §7.1 (`jeb_rise_of_the_robots_9c1e4b27.plan.md:273-291,301-305`).

## Context

Jeb publishes under a **dedicated bot key**. Profile copy states it is automated and operated by Synonym (`src/profile.ts:5-10,55-60`; `docs/voice.md:25-28`). Status default `"automated"` (`BOT_STATUS`, `src/profile.ts:6`). Specs validation is `PubkySpecsBuilder.createUser` (`src/profile.ts:79-80`) — today’s schema has **no** `automation` object; the additive field is being drafted on `pubky-app-specs` branch `proposal/bot-automation-field` (plan: `operator` pubky, `capabilities`, `source` URL, `policy` URL; prefer optional field over a new object — `jeb_rise_of_the_robots_9c1e4b27.plan.md:273-279`). As of this ADR that branch’s recent commits are marketplace objects, not the field text; the **proposal target** is still that branch.

Production identity: **fresh dedicated key**, secret only in the deploy target; old Jeb retired with a pointer post (`jeb_rise_of_the_robots_9c1e4b27.plan.md:376`). Staging key is separate (`…399`).

**Three-process trust boundary** (`docs/stage1-week2-report.md:18-21`; `docs/kimi-audit-stage1.md:745-748`; `src/keys.ts`):

| Role | Signing secret | Model/Scout keys | Homeserver session |
| --- | --- | --- | --- |
| ingest | forbidden (`assertNoKeyMaterial`, `INGEST_ALLOWLIST`) | no | no (`JEB_HOMESERVER` excluded from children, `src/keys.ts:58-62`) |
| reason | forbidden | yes (`REASON_ALLOWLIST`) | no |
| publish | yes (`PUBKY_BOT_*` / mnemonic / 0600 file) | not required | yes |

Children get explicit allowlists, not a denylist scrub (`src/keys.ts:39-53,162-178`; `docs/secrets-hardening-report.md:15-29`). Publisher is the only PUT path; outbound secret scan is last-gate (`docs/secrets-hardening-report.md:31-37`). Kimi: trust-boundary core survived remediation (`docs/kimi-reaudit-stage1.md:55`).

Self-tags on Jeb’s replies are attributable to **Jeb’s key** (R3) (`docs/voice.md:106-111`). Loop/bot-author policy keys off the bot pk plus declared automation (`src/policy.ts:96-163`).

Pubchi: own key generated on device (Ring); user root key never on the bot host; **autonomous** mode publishes as the bot; **assisted** publishes as the user **client-side**; revocation via Ring session revocation (`pubky-core` `feat/session-revocation`) (`jeb_rise_of_the_robots_9c1e4b27.plan.md:301-305`). No server-side delegation of the user’s signing authority.

## Options

- **A — Separate bot key; owner declared on the profile (recommended).** Reputation, blocks, tags, follows attach to the bot. Owner link is metadata. Revoke the bot session/key without rotating the human.
- **B — Shared owner key.** Bot posts and tags are indistinguishable from the human.
- **C — Delegated session of the owner key on a server.** Server holds a homeserver session for the user’s root identity.

## Scored matrix

| Criterion | Weight | A — bot key + owner field | B — shared owner key | C — delegated owner session |
|---|---:|---|---|---|
| Reputation separable / revocable | 25 | **5 → 125.** Mute/block/unfollow the bot; mint a new bot key; owner key untouched. Matches §6.5 recommendation (`jeb_rise_of_the_robots_9c1e4b27.plan.md:291`). | **1 → 25.** Bot spam burns the human. | **2 → 50.** Revoking a session helps; posts already under the human key stay. |
| Auth model (no server delegation) | 20 | **5 → 100.** Jeb’s publisher holds **Jeb’s** secret only (`src/keys.ts:12-27,29-37`). Pubchi autonomous same; assisted is client-side (`jeb_rise_of_the_robots_9c1e4b27.plan.md:304`). | **3 → 60.** Human secret would have to reach the bot host for autonomous posts. | **1 → 20.** Explicitly rejected (`jeb_rise_of_the_robots_9c1e4b27.plan.md:304`). |
| Transparency | 15 | **5 → 75.** Profile + voice already say automated (`src/profile.ts:9-10`; `docs/voice.md:25-28`). `automation` field makes operator machine-readable. | **1 → 15.** Hidden agent. | **2 → 30.** Session on a server is not visible on the post. |
| Process isolation evidence | 15 | **5 → 75.** Three roles, allowlists, Kimi SHIP on secrets re-audit (`docs/kimi-audit-secrets-2.md` verdict SHIP via `docs/secrets-hardening-report.md:9-11`). | **2 → 30.** One key blurs ingest/reason/publish incentives. | **1 → 15.** Owner secret on the same class of host as today’s publisher. |
| Graph semantics (tags/follows) | 15 | **4 → 60.** Bot tags are bot claims (R3, `docs/voice.md:110-111`). Distance weighting can treat new bot keys as cheap (ADR 0004). | **2 → 30.** Inflates human claim counts. | **2 → 30.** Same as B for published objects. |
| Specs / App readiness | 10 | **3 → 30.** Field not in `createUser` yet; branch `proposal/bot-automation-field` is the draft venue. Status/bio workaround works today. | **4 → 40.** No spec change. | **2 → 20.** Needs session-delegation the protocol does not offer. |
| **Total** | **100** | **465/500 = 93/100** | **200/500 = 40/100** | **165/500 = 33/100** |

## Decision

**Option A.** Every autonomous bot (Jeb, Pubchi, third-party Kit bots) has its own key. The owner’s pubky is declared on the profile: until specs land, Jeb uses `status=automated`, bio “operated by Synonym”, and source/policy links (`src/profile.ts:16-18,55-60`); after merge, populate `automation.operator` / `source` / `policy` / `capabilities` as proposed on `pubky-app-specs` `proposal/bot-automation-field` (`jeb_rise_of_the_robots_9c1e4b27.plan.md:275-277`).

Jeb keeps the three-process split: only publish loads key material; reason/ingest `assertNoKeyMaterial()` (`src/keys.ts:29-37,144-178`). Pubchi autonomous uses the same pattern on the user’s device-generated bot key; session revocation is Ring/`pubky-core` `feat/session-revocation`, not a Synonym kill of the user’s root key (`jeb_rise_of_the_robots_9c1e4b27.plan.md:304`).

Do not implement C. Do not let Jeb (or Pubchi autonomous) PUT under the operator/user root key.

## Consequences

- Blocking Jeb does not block Synonym humans; firing Jeb is a key/session revoke plus a pointer post (`jeb_rise_of_the_robots_9c1e4b27.plan.md:376`).
- `declaredAutomation` stays until App renders `automation` (`src/policy.ts:145-155`; ADR 0004).
- Assisted Pubchi tags/posts that must carry **user** reputation are user-session PUTs, not bot-key PUTs (`jeb_rise_of_the_robots_9c1e4b27.plan.md:304`).
- BitcoinErrorLog fork first for the specs proposal; upstream PR only with approval (`jeb_rise_of_the_robots_9c1e4b27.plan.md:275`).

## What would change our mind

- Specs rejecting an additive `automation` field and mandating a different object — keep A’s key split; change only the profile encoding.
- A future, audited **capability-limited** delegation model that still cannot spend the user’s root key — revisit C for assisted-mode server drafts only, never for Jeb.
- Evidence that users cannot distinguish bot vs human keys in App after the badge ships — that is an App bug, not a reason to merge keys.
- Loss of process isolation (reason process loading `PUBKY_BOT_*`) — stop ship; Kimi re-audit (`docs/kimi-audit-stage1.md` Q1).
