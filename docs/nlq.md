# NL query service

Library module `@pubky/bot-kit` `nlq/` plus a thin process (`--role nlq`). It turns a natural-language question into allowlisted typed Scout (and Nexus read) tool calls and returns the same provenance objects the reason-process answer loop already uses.

`answerMention` stays in the reason process. This service is a second consumer of the Scout stack, not a rewrite of compose/voice.

## Process

```
node dist/main.js --role nlq
# or
npx tsx src/main.ts --role nlq
```

Startup calls `assertNoKeyMaterial()` first. The process must not see `PUBKY_BOT_SECRET_KEY_HEX`, `PUBKY_BOT_SECRET_KEY_FILE`, or `PUBKY_BOT_MNEMONIC`. It never constructs a `PublishStore` and never writes `publish_requests`.

HTTP bind defaults to loopback. The client QPS limiter, per-mention/daily Scout budgets, circuit breaker, and raw-Cypher guard all apply through `createScoutTools` — the planner does not call `ScoutClient.query` itself.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/healthz` | `{ ok, role: "nlq", scoutSchema }` (same schema health snapshot as reason) |
| `POST` | `/v1/query` | Run one NL query. Alias: `/query`. |

Malformed JSON or a missing `question` returns HTTP 400 with the same typed body (`outcome: "unsupported"`). Every planner/tool failure returns HTTP 200 with `outcome` + `reason`. The server does not throw a 500 with a stack.

## Request

```ts
{
  question: string;
  asker?: string;          // pubky of the asking user (trust_view / profile_card)
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
    | "guard_rejected"
    | "tool_error"
    | "declined"
    | "ignored"
    | "unsupported";
  reason: string;          // human-readable; never a stack
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
2. Fetch `GET {scoutUrl}/v1/schema` via the existing schema cache. **Fail-closed:** if the fetch has never succeeded this process (source is not `live`), return `schema_unavailable`. The planner does not guess from `schema.golden.json`.
3. Reject questions that name relationship types absent from the live schema (`schema_unsupported`).
4. Map the question onto one allowlisted typed tool (`toolsForIntent` catalog). Validate that tool’s product templates against `schema-deps` / `extractCypherSchemaRefs` before any `POST /v1/query`.
5. Execute only through `createScoutTools` (or `nexusTools` for REST reads).

Raw Cypher (`query_graph`) is planned only when the question is itself a Cypher statement **and** `JEB_SCOUT_RAW_ENABLED=1`. Otherwise the service returns `guard_rejected` / `raw cypher disabled` and does not call Scout.

## Environment

All `JEB_NLQ_*` names are on the reason allowlist and carry no secrets.

| Var | Default | Meaning |
| --- | --- | --- |
| `JEB_NLQ_PORT` | `3014` | HTTP port |
| `JEB_NLQ_BIND` | `127.0.0.1` | Listen address (loopback-only default) |
| `JEB_SCOUT_URL` | `https://nexus-scout.pubky.app` | Scout origin (SSRF-pinned) |
| `JEB_SCOUT_RAW_ENABLED` | unset / off | Operator hatch for `query_graph` |
| `JEB_SCOUT_*` | see `docs/scout.md` | Timeouts, caps, QPS, breaker, schema refresh |
| `DATABASE_URL` / `JEB_DB_URL_REASON` | required | `scout_queries` budget rows only |
| `JEB_NEXUS_URL` | staging default | Optional Nexus REST tools |

Do not set any `PUBKY_BOT_*` key var in this process.

## Safety posture

- Typed tools first (ADR 0003 option A). Raw Cypher default-off, then `guardRawCypher` + schema-aware guard.
- Schema-fail-closed planner: no live schema → no plan.
- Template dependency check: a tool whose Cypher names a missing label/rel/property is rejected locally.
- Budgets, limiter, and circuit breaker are the same objects the reason process uses.
- Read-only: no homeserver session, no publish queue, no key material.

## What this service does not do

- Compose or voice-lint an answer (`answerMention` stays in reason).
- Call `search_knowledge` or run the model tool loop.
- Enable raw Cypher for the public beta.
- Enumerate MUTED counterparties (`profile_card` exposes `muted_count` only).
- Invent relationship types (no likes; `top_posts` is bookmarks / reposts / replies).
- Hold or load a bot secret.
