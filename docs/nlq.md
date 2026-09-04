# NL query service

Library module `@pubky/bot-kit` `nlq/` plus a thin process (`--role nlq`). It turns a natural-language question into allowlisted typed Scout (and Nexus read) tool calls and returns the same provenance objects the reason-process answer loop already uses.

`answerMention` stays in the reason process. This service is a second consumer of the Scout stack, not a rewrite of compose/voice.

## Process

```
node dist/main.js --role nlq
# or
npx tsx src/main.ts --role nlq
```

Startup calls `assertNoKeyMaterial()` before any key-dependent initialization. The process must not see `PUBKY_BOT_SECRET_KEY_HEX`, `PUBKY_BOT_SECRET_KEY_FILE`, or `PUBKY_BOT_MNEMONIC`. It never constructs a `PublishStore` and never writes `publish_requests`.

HTTP bind defaults to loopback (`127.0.0.1` / `::1` only). A non-loopback `JEB_NLQ_BIND` is refused unless `JEB_NLQ_BIND_DANGEROUS=1` is also set (then the process `log.warn`s at startup and on every listen). `"localhost"` is not accepted. The client QPS limiter, per-caller Scout budgets (`mention_key` prefix `nlq:`), NLQ daily ceiling, circuit breaker, DB `scout` kill switch, and raw-Cypher guard all apply through `createScoutTools` — the planner does not call `ScoutClient.query` itself.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/healthz` | `{ ok, role: "nlq", scoutSchema }` (same schema health snapshot as reason) |
| `POST` | `/v1/query` | Run one NL query. Alias: `/query`. |

Malformed JSON or a missing `question` returns HTTP 400 with the same typed body (`outcome: "unsupported"`). Every planner/tool failure returns HTTP 200 with `outcome` + `reason`. The server does not throw a 500 with a stack.

HTTP hardening (audit A4 F-12): `requestTimeout` 30s, `headersTimeout` 10s, `maxConnections` 128.

## Request

```ts
{
  question: string;
  asker?: string;          // unauthenticated hint for trust_view / profile_card.
                           // Anyone can set this; it is not an identity. Budgets
                           // are keyed on the caller (loopback remote address,
                           // or JEB_NLQ_TOKEN bearer), never on asker.
  scope?: {
    time_range?: { since?: number; until?: number };
    graph_scope?: { pubky?: string; hops?: number };
  };
}
```

## Response

```ts
{
  outcome:
    | "ok"
    | "schema_unavailable"
    | "schema_unsupported"
    | "budget_exhausted"
    | "circuit_open"
    | "switch_off"
    | "guard_rejected"
    | "tool_error"
    | "declined"
    | "ignored"
    | "unsupported";
  reason: string;          // static string; never a stack, never e.message / hostnames
  intent: Intent;          // same catalog as Jeb classifyIntent
  planned: { tool: string; args: object }[];
  results: unknown[];      // tool execute() payloads
  toolTrace: unknown[];    // [{ toolCalls: [{ name, args }], result }]
  sources: string[];       // pubky:// URIs found in results
}
```

Provenance shapes inside `results` match the answer loop:

- Nexus REST: `{ uri, post|posts|user|tags|replies, provenance: "nexus" }`
- Scout: `EvidenceMeta` (`provenance: "scout"`, `tool`, `truncated`, `notes`, `scope`) plus the tool-specific fields (`posts`, `claims`, `tag_claims`, …)

## Planner

1. Classify intent with the Kit `classifyIntent` mechanism. Jeb injects its regex tables (`INTENT_REGEX_TABLES` in `src/intent.ts`); routing order is byte-identical.
2. Read the process-wide TTL schema cache (`ensureScoutSchemaCache`, `JEB_SCOUT_SCHEMA_REFRESH_MS`). **Fail-closed:** if the fetch has never succeeded this process (source is not `live`), return `schema_unavailable`. The planner does not guess from `schema.golden.json` and does not refresh per request.
3. Best-effort UX: reject questions that name ALL-CAPS relationship-looking tokens absent from the live schema (`schema_unsupported`). This is not a security boundary — mixed-case / unicode names skip it, and Cypher-looking questions skip it entirely. Typed tools never interpolate question text as a Cypher identifier.
4. Map the question onto one allowlisted typed tool (`toolsForIntent` catalog). Validate that tool’s product templates against `schema-deps` / `extractCypherSchemaRefs` before any `POST /v1/query`. Tool args are `safeParse`d against the tool zod schema before `execute`.
5. Execute only through `createScoutTools` (or `nexusTools` for REST reads). The circuit breaker and DB/env scout switch are checked before planning.

Raw Cypher (`query_graph`) is planned only when the question is itself a Cypher statement **and** `JEB_SCOUT_RAW_ENABLED=1`. Otherwise the service returns `guard_rejected` / `raw cypher disabled` and does not call Scout.

## Environment

All `JEB_NLQ_*` names are on the reason allowlist. `JEB_NLQ_TOKEN` is a shared secret (caller key only; never log it). The others carry no secrets.

| Var | Default | Meaning |
| --- | --- | --- |
| `JEB_NLQ_PORT` | `3014` | HTTP port (int 1–65535; named `invalid JEB_NLQ_PORT` on garbage) |
| `JEB_NLQ_BIND` | `127.0.0.1` | Listen address. Must be an IP (`net.isIP`). Loopback only unless `JEB_NLQ_BIND_DANGEROUS=1`. |
| `JEB_NLQ_BIND_DANGEROUS` | unset | Opt-in for a non-loopback bind. Warns loudly at startup and on every listen. |
| `JEB_NLQ_TOKEN` | unset | Optional shared bearer. When the request sends a matching `Authorization: Bearer`, the caller key is `nlq:token`. Never logged. |
| `JEB_NLQ_DAILY_QUERIES` | `200` | Daily ceiling over `scout_queries` rows with `mention_key LIKE 'nlq:%'`, separate from `JEB_SCOUT_DAILY_CEILING`. |
| `JEB_SCOUT_URL` | `https://nexus-scout.pubky.app` | Scout origin (SSRF-pinned) |
| `JEB_SCOUT_RAW_ENABLED` | unset / off | Operator hatch for `query_graph` |
| `JEB_SCOUT_*` | see `docs/scout.md` | Timeouts, caps, QPS, breaker, schema refresh |
| `DATABASE_URL` / `JEB_DB_URL_REASON` | required | `scout_queries` budget rows only |
| `JEB_NEXUS_URL` | staging default | Optional Nexus REST tools |

Do not set any `PUBKY_BOT_*` key var in this process.

### Minimal env for the nlq unit

A directly-launched `--role nlq` process inherits the operator env. Prefer launching it with only allowlisted names set:

`DATABASE_URL` or `JEB_DB_URL_REASON`, `JEB_BOT_PK`, `JEB_SKIP_MIGRATIONS`, `JEB_LOG_LEVEL`, `JEB_NEXUS_URL`, `JEB_SCOUT_URL`, `JEB_SCOUT_ENABLED`, `JEB_SCOUT_TIMEOUT_MS`, `JEB_SCOUT_LIMIT_MAX`, `JEB_SCOUT_RAW_ENABLED`, `JEB_SCOUT_PER_MENTION_CAP`, `JEB_SCOUT_DAILY_CEILING`, `JEB_SCOUT_RAW_PER_USER_DAILY`, `JEB_SCOUT_RAW_GLOBAL_DAILY`, `JEB_SCOUT_PROFILE_PROP_MAX`, `JEB_SCOUT_CLAIMANT_CAP`, `JEB_SCOUT_MAX_QPS`, `JEB_SCOUT_SCHEMA_REFRESH_MS`, `JEB_NLQ_PORT`, `JEB_NLQ_BIND`, `JEB_NLQ_BIND_DANGEROUS`, `JEB_NLQ_DAILY_QUERIES`, `JEB_NLQ_TOKEN`, `JEB_SWITCH_GLOBAL`, `JEB_SWITCH_SCOUT`, `JEB_DISABLED`.

## Safety posture

- Typed tools first (ADR 0003 option A). Raw Cypher default-off, then `guardRawCypher` + schema-aware guard.
- Schema-fail-closed planner: no live schema → no plan. Schema is cached on a TTL, not fetched per request.
- Template dependency check: a tool whose Cypher names a missing label/rel/property is rejected locally.
- Caller-keyed cap: remote address on loopback (or `JEB_NLQ_TOKEN` bearer) recorded as `mention_key` `nlq:…` so `JEB_SCOUT_PER_MENTION_CAP` applies. NLQ also has its own daily ceiling (`JEB_NLQ_DAILY_QUERIES`, default 200) over those rows, separate from the reason-process 400/day Scout ceiling. `asker` is never a budget key.
- Limiter and circuit breaker are the same objects the reason process uses. Breaker is checked before planning.
- The Postgres `scout` switch (and env `JEB_SWITCH_SCOUT`) refuse tools without a Scout call.
- Read-only: no homeserver session, no publish queue, no key material.

## What this service does not do

- Compose or voice-lint an answer (`answerMention` stays in reason).
- Call `search_knowledge` or run the model tool loop.
- Enable raw Cypher for the public beta.
- Enumerate MUTED counterparties (`profile_card` exposes `muted_count` only).
- Invent relationship types (no likes; `top_posts` is bookmarks / reposts / replies).
- Hold or load a bot secret.
- Treat `asker` as an authenticated user.
