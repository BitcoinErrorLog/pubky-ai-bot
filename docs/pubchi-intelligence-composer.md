# Pubchi intelligence composer

The composer is the local safety boundary for model-produced Cypher. It accepts
only one read query, validates it against the live Scout schema, injects the
verified tenant owner, and then passes the result through the existing Scout
guard.

## Rules

- The statement is at most 2,000 bytes, starts with `MATCH`, `OPTIONAL MATCH`,
  `WITH`, `UNWIND`, or `RETURN`, and has no comments or semicolons.
- Writes, `LOAD CSV`, all `CALL` forms, procedures (`apoc`, `db`, `dbms`, `gds`),
  admin clauses, and unbounded paths are rejected.
- A terminal literal `LIMIT` from 1 through 50 is required; values over 50 are
  rejected rather than clamped.
- Later `MATCH` clauses must share a variable with an earlier clause. There are
  at most two `OPTIONAL MATCH` clauses, and the first match needs an id or
  indexed-property parameter anchor.
- `ORDER BY` is limited to `indexed_at`, `created_at`, or an alias computed by
  an aggregate in the query. These are the only currently indexed temporal
  properties exposed by Scout, and aggregate aliases do not add a new graph
  access path.
- User-derived strings, Pubkys, timestamps, and lists are parameters. `$owner`
  is always injected from the verified tenant. Owner-network queries must
  contain an owner id anchor.
- MUTED edges may only be returned as an owner-anchored aggregate.
- Labels, relationship types, and properties must occur in the live schema.

## Fixed errors

`COMPOSER_HINTS` contains one non-reflective hint for every
`ComposerErrorCode`: `EMPTY_QUERY`, `QUERY_TOO_LONG`, `QUERY_NOT_READ_ONLY`,
`QUERY_START`, `MULTIPLE_STATEMENTS`, `COMMENT`, `UNBOUNDED_PATH`,
`LIMIT_REQUIRED`, `LIMIT_TOO_HIGH`, `CARTESIAN_PRODUCT`, `OPTIONAL_MATCH_CAP`,
`ORDER_BY_UNINDEXED`, `ANCHOR_REQUIRED`, `PARAM_REQUIRED`, `LITERAL_LEAK`,
`TENANT_PARAM_REJECTED`, `OWNER_ANCHOR_REQUIRED`, `SCHEMA`,
`MUTED_VISIBILITY`, `PARAM_INVALID`, and `COST`.

## Budgets

`memoryComposedQueryBudget` and `postgresComposedQueryBudget` count successful
`composed_cypher` rows in `scout_queries`: 60 per owner per UTC day and 2,000
globally per UTC day. `ScoutCallMeter` caps a request at 10 calls and 20,000
cumulative Scout milliseconds.

## Telemetry and server enforcement

`composerTelemetry` emits only the result code, SHA-256 query hash,
SHA-256 sorted parameter-name/type shape, schema hash, and query byte count.
Rationale, scope labels, questions, owner context, parameter values, and Scout
messages are not telemetry.

Scout still enforces its server-side read-only sanitizer, procedure/admin
denials, timeout, row cap, schema policy, and shared capacity controls. Pubchi
enforces tenant injection, parameter provenance, cost shape, owner/MUTED
visibility, per-owner/global composed-query budgets, and request call/time
budgets before sending the request.
