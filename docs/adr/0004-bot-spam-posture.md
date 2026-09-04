# ADR 0004: Bot spam posture

**Status:** Proposed — John accepts  
**Date:** 2026-09-04  
**Open question:** Robots §13 Q3 (`rise-of-the-robots.md` §13 item 3); plan §6.5 and §8 (`jeb_rise_of_the_robots_9c1e4b27.plan.md:289-291,332`).

## Context

Anyone who can sign up a homeserver key can run a bot. The structural controls named in the plan are **Homegate signup cost on bot keys** and **graph-distance weighting**; Jeb does not implement Homegate or distance scoring itself (`jeb_rise_of_the_robots_9c1e4b27.plan.md:291,332`).

What Stage 1 **does** implement is reach-limiting on Jeb’s own key:

| Control | Default | Behaviour | Source |
| --- | --- | --- | --- |
| Thread cap | 12 Jeb replies / `root_uri` | notified skip `thread_cap` | `docs/limits.md:7`; `src/policy.ts:44-46,138` |
| Per-user turns in thread | 6 | notified skip `user_turn_cap` | `docs/limits.md:8`; `src/policy.ts:51-54,139` |
| Per-user hour | 5 published replies | notified skip `user_hourly_cap` | `docs/limits.md:9`; `src/policy.ts:48-50,140` |
| Global tokens | 5_000_000 / UTC day | notified skip `budget` | `docs/limits.md:10` |
| Per-user tokens | 600_000 / UTC day | same | `docs/limits.md:11` |
| Bot author | profile regex or `JEB_KNOWN_BOTS` | silent skip `bot_author` | `src/policy.ts:19-21,145-163`; `docs/voice.md:91-93` |
| Bot loop | Jeb→Jeb child/parent, or ≥3 consecutive bot posts | silent skip `bot_loop` | `src/policy.ts:96-117,137` |
| Unaddressed | not mention and not reply-to-Jeb | silent skip `unaddressed` | `src/policy.ts:77-94,136` |
| Opt-out | first-person phrases | silent skip `optout` after one confirm | `src/optout.ts`; `docs/limits.md:48-60` |
| Blocklist | env + Postgres, fail-closed | silent skip `blocklist` | `src/policy.ts:38-42,165-171` |
| Notice anti-spam | 1 notice / (author, reason) / 6 h; 1 / thread / reason | further hits `notice_suppressed` | `docs/limits.md:25-27` |
| Self-tags | own replies only, ≤3 labels | never tags others | `docs/voice.md:106-117` |
| Ambient | mention/reply notifications only | tag/follow/new_post dropped | `docs/stage1-week2-report.md:99` |

Opt-out confirmations are zero-token, one per **state transition** (`docs/limits.md:54-56`; `src/optout.ts:113-116`). They never overwrite a prior answer on `requeue --replace` (`docs/limits.md:67-69`).

Write-path halt: production kill-switch drill **6/6** within 60 s; `global` time-to-effect **6075 ms** (`docs/killswitch-drill.md:209-218`). Plan R4: Jeb has no privileged distribution (`jeb_rise_of_the_robots_9c1e4b27.plan.md:41`).

Homegate, graph-distance weights, and ModerationBot are **not** in this repository. Arena scoring is specified as normal tags/follows, sybil pressure priced by Homegate + distance, **ModerationBot flags, never enforces** (`jeb_rise_of_the_robots_9c1e4b27.plan.md:332`).

## Options

- **A — Graph economics + bot self-limits (recommended).** Signup cost and distance weighting in Homegate/Nexus/Arena; each bot (Jeb as reference) ships the cap/loop/opt-out/no-reply-to-bots policy. No central bot allowlist.
- **B — Platform allowlist.** Only Synonym-approved bot keys may post or appear in feeds.
- **C — Jeb-only heuristics, no protocol economics.** Caps on Jeb; third-party bots unconstrained at the protocol.

## Scored matrix

| Criterion | Weight | A — economics + self-limits | B — allowlist | C — Jeb-only |
|---|---:|---|---|---|
| Open ecosystem (Robots §10) | 20 | **5 → 100.** Anyone can ship a key; Homegate already prices new keys (`jeb_rise_of_the_robots_9c1e4b27.plan.md:291`). | **1 → 20.** Central gatekeeping, contradicting §13 Q3’s “without central gatekeeping”. | **4 → 80.** Open, but unconstrained bots dominate. |
| Sybil / reply spam | 25 | **4 → 100.** Jeb cannot reply-loop (`src/policy.ts:96-117`) or answer bots (`:135,157-163`). Distance weighting is specified, not measured here. | **5 → 125.** Effective, political. | **2 → 50.** Only Jeb is polite. |
| User control | 15 | **5 → 75.** Opt-out is public, first-person, reversible (`src/optout.ts:47-101`; `docs/limits.md:48-52`). | **2 → 30.** Users wait on operators. | **4 → 60.** Opt-out works for Jeb only. |
| Operator halt | 15 | **5 → 75.** Switches drilled (`docs/killswitch-drill.md:209-218`). | **4 → 60.** Ban is slower than a switch. | **5 → 75.** Same Jeb switches. |
| Arena / third-party bots | 15 | **5 → 75.** Flags ≠ enforcement (`jeb_rise_of_the_robots_9c1e4b27.plan.md:332`). | **2 → 30.** Arena becomes a Synonym list. | **2 → 30.** No shared bar for Kit bots. |
| Evidence in Stage 1 | 10 | **4 → 40.** Caps, loop, opt-out, silent bot skip are code (`src/policy.ts`, `src/optout.ts`). Homegate/distance are plan-level. | **1 → 10.** Not built. | **3 → 30.** Ignores §6.5. |
| **Total** | **100** | **465/500 = 93/100** | **275/500 = 55/100** | **325/500 = 65/100** |

## Decision

**Option A.**

1. **Homegate** applies to bot keys the same as human keys. Jeb already consumes a single-use signup token on first session (`docs/kimi-reaudit-stage1.md:43`; `docs/stage1-week2-report.md:76` F12). No bot discount.
2. **Graph-distance weighting** (follows/tags from distant or empty neighbourhoods count less) is Arena/Nexus work, not a Jeb special case (`jeb_rise_of_the_robots_9c1e4b27.plan.md:332`).
3. **Jeb’s anti-abuse surface** above is the reference implementation for Bot Kit: addressed-only, no replies to declared/known bots, loop guard, numeric caps, fail-closed blacklist/budget, public opt-out, notice anti-spam, no tagging of others, kill switches.
4. **Third-party bots** that want Kit/Arena inclusion must satisfy at least: own key + declared operator (ADR 0005); addressed or explicitly opted-in targets; a loop guard equivalent to `botLoopInChain`; a documented opt-out or ignore-blocklist; no privileged feed injection; Homegate-paid identity. They need not copy Jeb’s exact 12/6/5 numbers.
5. **ModerationBot** (when it exists) **flags, never enforces** — no protocol takedown from a bot (`jeb_rise_of_the_robots_9c1e4b27.plan.md:332`).

## Consequences

- Spam complaints about Jeb are answered with the public table in `docs/limits.md` and opt-out copy (`src/optout.ts:7-10`).
- Calibrating “new bots with no connections carry less weight” (`rise-of-the-robots.md` §13 Q3) is a Nexus/Arena measurement, not a Jeb merge.
- `declaredAutomation` is a heuristic on name/bio (`src/policy.ts:150`) until the specs `automation` field ships (ADR 0005); false negatives stay on `JEB_KNOWN_BOTS`.

## What would change our mind

- Measured bot-to-human reply ratio that drowns human signal (Robots §13 Q7) after Homegate+distance are live — then tighten Kit defaults (e.g. thread cap) or add feed-level distance thresholds, still without an allowlist.
- Homegate not applying to bot signups — that would force a temporary allowlist (B) until pricing is restored.
- A legal requirement to pre-register bots — document B as a jurisdiction overlay, not the protocol default.
- Opt-out false positives at scale (`src/optout.ts` classifiers) — tighten phrases, do not drop opt-out.
