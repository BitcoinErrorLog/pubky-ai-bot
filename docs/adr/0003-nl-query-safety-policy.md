# ADR 0003: Natural-language query safety policy

**Status:** Proposed — John accepts  
**Date:** 2026-09-04  
**Open question:** Robots §13 Q2 (`rise-of-the-robots.md` §13 item 2); plan §6.3 and §6.5 (`jeb_rise_of_the_robots_9c1e4b27.plan.md:281-291`).

## Context

Public graph data can still be assembled into person-profiling or mute-enumeration answers. Stage 1’s response is **typed tools first**, not model-authored Cypher.

Scout tools return evidence (URIs, authors, timestamps, claim counts + claimant ids, scope, `truncated`) and not interpretation strings (`docs/scout.md:3-4`, R1). Intents that may call Scout: `research_pubky`, `find`, `compare`, `evidence_map`, `answer` (`docs/scout.md:32`). Caps: **12** ok-TRUE calls per mention (`JEB_SCOUT_PER_MENTION_CAP`), **400** ok-TRUE per UTC day (`JEB_SCOUT_DAILY_CEILING`); raw Cypher additionally **8**/user/day and **40** global/day (`docs/scout.md:34`; `src/config.ts:200-206`). Client `LIMIT` default max **50**, Scout server max **100**, 10 s server timeout (`docs/scout.md:99`; `src/config.ts:200`). Variable-length FOLLOWS in product tools: `follow_path` max **3** hops, `trust_view` **1–2** hops (`src/scout/templates.ts:458-459`; `docs/scout.md:109,117`). `FOLLOW_TOOL_LIMIT = 25` (`src/scout/templates.ts:403`).

`query_graph` is off unless `JEB_SCOUT_RAW_ENABLED=1` (`docs/scout.md:21`; `src/scout/guard.ts:194`). Kimi stage-1 re-audit: remaining denylist evasions are **blocking only if raw is on** (`docs/kimi-reaudit-stage1.md:28,51-53`). MUTED counterparty enumeration was F-B; closed by `checkMutedVisibility` (`docs/kimi-audit-2026-09-04b.md:30,89`; `src/scout/guard.ts:115-140`).

Live public Scout latencies (2026-09-04) are hundreds of ms to ~1.2 s per template (`docs/scout.md:145-166`). Production recommendation: Jeb-owned Scout replica; public instance is a shared 50 rps cap (`docs/scout.md:93-95`).

Kill switch `scout` refuses tools in **1 ms** locally / **6 ms** production (`docs/killswitch-drill.md:192-199,209-218`).

## Options

- **A — Typed catalogue + guarded raw hatch (current).** Zod tools compile to parametrised Cypher; raw Cypher only with operator switch + `guardRawCypher`.
- **B — Typed tools only; delete `query_graph`.** No model- or operator-supplied Cypher in Jeb.
- **C — Model-generated Cypher as the default path**, Scout sanitizer only.

## Concrete guard rules (`src/scout/guard.ts`)

`guardRawCypher` (`:189-218`) rejects, in order:

1. `rawEnabled === false` → `"raw cypher disabled"`
2. empty string; length **> 2000**
3. semicolon (multi-statement)
4. `//` or `/* */` comments
5. write tokens: `CREATE|MERGE|SET|DELETE|DETACH|REMOVE|DROP|FOREACH|LOAD|INSERT` (`WRITE`, `:8-9`)
6. admin/hint: `USE|SHOW|PROFILE|EXPLAIN|USING` (`ADMIN`, `:10`)
7. namespaced `CALL db.|apoc.|gds.|dbms.` (`PROC`, `:11`)
8. any `CALL` (`CALL_ANY`, `:12`) — live Scout rejects CALL including `CALL {}` (`docs/scout.md:100`)
9. must start with `MATCH` / `OPTIONAL MATCH` / `WITH` / `UNWIND` / `RETURN` (`START`, `:15`)
10. `LOAD CSV`
11. unbounded varlen paths: `[*]`, `[*..]`, `[*N..]` (`hasUnboundedVarlenPath`, `:178-187`; F-16 closed, `docs/kimi-audit-stage1.md:831`)
12. trailing `LIMIT` required; value clamped to `limitMax` (`clampRawLimit`, `:19-24`)
13. quoted user-looking literals must equal a param value (`looksLikeUserText`, `:36-41`)
14. `checkProfilingDenylist` (`:149-170`) then `checkMutedVisibility` (`:115-140`)

Profiling denylist (id-bound `:User` + `:AUTHORED`): no `.content`/`.attachments`; no `collect(node)` unless `size|count(collect(`; at most `JEB_SCOUT_PROFILE_PROP_MAX` (**3**) User props from `{name,bio,status,links,image,indexed_at,id}` (`USER_PROPS`, `:17`; `src/config.ts:206`). Id-binding includes `{id:…}`, `WHERE v.id =`, `v.id IN` (`hasIdBoundUser`, `:64-80`; F-02 closure `docs/kimi-audit-stage1.md:817`).

MUTED rule: with an id-bound user, MUTED counterparties and the edge variable may appear in `RETURN` only inside `count`/`size` (`:108-114`).

Provenance: tools pass gateway `truncated` through and do not infer it from `count === LIMIT` (`docs/scout.md:101`). `profile_card` exposes `muted_count` only (`docs/scout.md:143`).

## Scored matrix

| Criterion | Weight | A — typed + guarded raw | B — typed only | C — generated Cypher default |
|---|---:|---|---|---|
| Privacy vs profiling | 25 | **4 → 100.** Templates cannot enumerate muters (`docs/kimi-audit-2026-09-04b.md:30`). Raw still has R-02 whole-node / reversed-bind holes if enabled (`docs/kimi-reaudit-stage1.md:28,45-47`). | **5 → 125.** Removes the hatch those holes live in. | **1 → 25.** Directly the §13 Q2 failure mode. |
| Completeness of graph questions | 20 | **5 → 100.** Catalogue covers search, thread, identity, topics, debate, lurker rank, follow path, trust_view, etc. (`docs/scout.md:7-30`). Raw is the evidence channel for the next typed tool (`jeb_rise_of_the_robots_9c1e4b27.plan.md:191`). | **3 → 60.** New questions wait on a template PR. | **4 → 80.** Flexible; unsafe. |
| Operability | 15 | **4 → 60.** Switch + daily raw caps 8/40 (`src/config.ts:201-205`); scout switch drilled (`docs/killswitch-drill.md:33`). | **5 → 75.** One fewer privileged mode. | **2 → 30.** Cost/DoS via cartesian products (accepted residual F-16, `docs/kimi-reaudit-stage1.md:21`). |
| Stage 3 NL service reuse | 20 | **5 → 100.** Plan §6.3 is this stack extracted (`jeb_rise_of_the_robots_9c1e4b27.plan.md:281-283`). | **4 → 80.** Service can omit raw until needed. | **1 → 20.** Conflicts with “schema-aware planning from `/v1/schema`”. |
| Evidence / R1 | 20 | **5 → 100.** URI + claimant counts; voice R1–R3 (`docs/voice.md:67-76`; `docs/scout.md:3`). | **5 → 100.** Same. | **2 → 40.** Model Cypher tends to return interpretation-shaped rows. |
| **Total** | **100** | **460/500 = 92/100** | **440/500 = 88/100** | **195/500 = 39/100** |

## Decision

**Option A for Jeb, with raw default-off.** Typed tools are the NL→graph API. Keep `query_graph` as an **operator** hatch behind `JEB_SCOUT_RAW_ENABLED`, the rules listed above, and the 8/40 raw budgets. Do not enable raw for the public beta while R-02 stands (`docs/kimi-reaudit-stage1.md:53`).

**Schema-aware guard (2026-09-04).** Raw Cypher is additionally bound to the **active** Scout schema (`GET /v1/schema`, golden fallback). Unknown labels, relationship types, and properties are rejected so the hatch cannot probe names that are not in the public schema. Schema nodes/rels marked `private` or `denied` are rejected even when listed. Template dependencies are derived from `templates.ts` Cypher; a missing live field is an error-level alarm, not a crash. `summarizeScoutSchema` is the planner input for the Stage 3 NL query service; it is not yet injected into Jeb `answer.ts` prompts.

**Stage 3 NL query service** generalises A: schema from Scout `/v1/schema`, the same typed catalogue, the same denylist/MUTED/LIMIT/hop clamps, cost caps, and provenance envelope. Jeb, Pubchi, and App NL search are clients; the service stays beside Scout, never on Nexus write paths (`jeb_rise_of_the_robots_9c1e4b27.plan.md:281-283`).

**Planner is schema-fail-closed (step 14, 2026-09-04).** The NL query service planner (`packages/bot-kit/src/nlq/`) refuses to plan when `GET /v1/schema` has not succeeded this process (`source !== "live"`). Golden fallback remains valid for `guardRawCypher` and reason-process health, but the planner never guesses from it. Every planned typed template is checked against `schema-deps` before any `/v1/query`; a missing label, relationship type, or property is `schema_unsupported`, not a Scout call. Raw Cypher stays behind `JEB_SCOUT_RAW_ENABLED` (default off).

Prefer adding a typed tool over turning raw on. B is the fallback if R-02 cannot be closed before anyone needs the hatch.

## Consequences

- Product answers that look like “everything about [person]” must go through `profile_card` / `get_identity_summary` / `trust_view` / `rank_users`, which already cap shape (`docs/scout.md:137-143`).
- Cartesian products remain possible in raw; bounded by 10 s + caps (`docs/kimi-reaudit-stage1.md:21`).
- Raw Cypher cannot name graph elements outside the active schema (or private/denied ones inside it); schema fetch failure falls back to golden and is counted on `/healthz`.
- Run Jeb-owned Scout in production (`docs/scout.md:93-95`).

## What would change our mind

- Closing R-02 (whole-node RETURN, reversed `$id = u.id`, non-AUTHORED post walks) with a Kimi re-audit — then raw may be offered to operators with the existing 8/40 caps.
- A Stage 3 requirement that **no** process may accept free Cypher — switch to B and delete `query_graph`.
- Live Scout starting to allow `CALL {}` — then revisit `CALL_ANY` vs namespaced-only, without weakening writes/admin.
- Measured abuse of typed tools (e.g. stalking via repeated `mentions_of` / `profile_card`) — add per-target rate limits in the NL service, not a weaker denylist.
