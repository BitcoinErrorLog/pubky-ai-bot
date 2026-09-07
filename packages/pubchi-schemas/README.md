# `@pubky/pubchi-schemas`

Versioned Zod contracts for Pubchi Phase 0. App and the Pubchi service share this package so a request, feed proposal, or result is accepted only when it matches a closed schema.

## Versioning

- `version: 1` is the only accepted schema version in this package.
- **Within V1:** new optional fields may be added in a later package release. That is still `version: 1`. Older parsers in this package use Zod `.strict()`, so App and the service must upgrade the package together when a field is added.
- **V2:** any removed, renamed, or type-changed field, or a new required field. Bump `version` and add a new `*V2` parser. Do not reuse a V1 field for a new meaning.

Unknown fields are rejected (`UNKNOWN_FIELD`). Forbidden categories from the design §5 are rejected with a category-specific code.

## Path constants

Exported from `PATHS` and helpers. They match design §3 / §5 exactly.

| Object | Path / URI |
| --- | --- |
| Manifest | `/pub/pubchi.app/manifest.json` |
| Config | `/pub/pubchi.app/config.json` |
| Interests | `/pub/pubchi.app/interests.json` |
| Formats | `/pub/pubchi.app/formats.json` |
| Feed definition | `/pub/pubchi.app/feeds/<feed-id>.json` |
| Follower snapshot | `/pub/pubchi.app/follower-snapshots/<unix-seconds>.json` |
| What I missed cursor | `/pub/pubchi.app/cursors/what-i-missed.json` |
| Request binding | `/pub/pubchi.app/requests/<request-id>.json` |
| Suggestion | `/pub/pubchi.app/suggestions/<suggestion-id>.json` |
| Run receipt | `/pub/pubchi.app/runs/<run-id>.json` |
| **U → B binding** | `pubky://U/pub/pubchi.app/bots/B.json` (`ownerBindingUri`) |
| **U device delegation** | `pubky://U/pub/pubchi.app/devices/D.json` (`delegationUri`) |
| **B → U side** | `pubky://B/pub/pubky.app/profile.json` with `automation.operator = U` (`botProfileUri`) |

Manifest entries must be allowlisted. Paths with `..`, `%`, `?`, `//`, `\\`, or a `pubky://` prefix are `PATH_FORBIDDEN`.

## Schemas

### `TenantV1` (`pubchi-tenant`)

Service-side enrolled pair. Phase 0 fields:

- `bot` / `owner` — z32 pubkys
- `tier` — `read-only` only
- `brain` — locked Phase 0 reference (`vercel-ai` / `synonym-hosted` / `moonshot` / `kimi-k3` / `endpoint: null`)
- `budgets` — frozen `PHASE0_BUDGETS` (any other number is `BUDGET_NOT_FIXED`)
- `created_at` / `updated_at` / `version: 1`

### `RequestObjectV1` (`pubchi-request-object`) + verifier

Signed read-only request the App sends to the service:

`asker`, optional `signer`, `bot`, `purpose`, `body_sha256` (SHA-256 of canonical JSON of the ask body), `issued_at`, `expires_at` (max 600s window), `nonce` (32-byte hex), `signature` (Ed25519 by `signer ?? asker`). During the beta, an absent signer is the legacy root-U path and stays accepted **by default**. The service ships the cutover switch now: when it runs with `PUBCHI_REQUIRE_DEVICE_SIGNER=1`, any request lacking a `signer` is rejected (`UNAUTHORIZED`, 403). Unset or any other value keeps the default (legacy root-signed requests accepted).

`verifyRequestObjectV1` is the **root-only** verifier: it fails closed with `DELEGATION_INVALID` when a `signer` is present, because it has no delegation context and would otherwise silently skip the device policy. Signer-bearing requests must go through the delegation-aware gateway path (enrollment + `DeviceDelegationV1`).

`verifyRequestObjectV1` checks, each with its own code:

| Check | Code |
| --- | --- |
| Schema | `SCHEMA_INVALID` / `UNKNOWN_FIELD` / … |
| Signature by `asker` | `SIGNATURE_INVALID` |
| `issued_at` more than 60s in the future | `CLOCK_SKEW` |
| `now > expires_at + 60s` | `REQUEST_EXPIRED` |
| TTL or `expires_at <= issued_at` | `REQUEST_MALFORMED` |
| Canonical body hash | `BODY_HASH_MISMATCH` |
| `asker !== tenant.owner` | `ASKER_MISMATCH` |
| `bot !== tenant.bot` | `BOT_MISMATCH` |
| `signer` present (fail closed; use the delegation-aware path) | `DELEGATION_INVALID` |
| `NonceStore.consume` replay | `NONCE_REPLAY` |

Signing uses Node `crypto` Ed25519 and `@synonymdev/pubky` `PublicKey` / `Keypair`. No new crypto dependency. `MemoryNonceStore` is the in-memory impl; `NonceStore` is the Postgres-ready interface (no DB code here).

The graph object at `/pub/pubchi.app/requests/<id>.json` is `RequestBindingV1` (`pubchi-request`): hash, capability, expiry — no body, nonce, or session material.

### `DeviceDelegationV1` (`pubchi-device-delegation`)

The owner U's public homeserver object at `/pub/pubchi.app/devices/<D>.json` authorizes one non-extractable browser Ed25519 device key D for one bot B. It contains `owner`, `signer`, `bot`, `purposes` (Phase 0 purposes only), `created_at`, `expires_at`, and `signature`. The expiry window is at most 30 days.

The signature is by D over the UTF-8 bytes of `canonicalJson({ schema, version, owner, signer, bot, purposes, created_at, expires_at })`: recursively sorted object keys, array order preserved, no whitespace, and no undefined values. The service reads this object only after the request signature and U→B enrollment verify, then checks the owner, exact device path, bot, purpose, expiry, and D proof. Delegation failures do not consume the request nonce.

Expiry uses the same 60s clock-skew allowance as the request path: a delegation is honored until `now > expires_at + 60s`, and a `created_at` more than 60s in the future is rejected (`DELEGATION_INVALID`). This is validation-only; the signed bytes are unchanged.

The homeserver operator can forge this delegation because it already has the existing U→B enrollment trust; this contract does not create a new server trust domain. The keyless Pubchi process remains keyless.

### `FeedProposalV1` (`pubchi-feed-proposal`)

Wraps a `PubkyAppFeed` that must pass installed `pubky-app-specs` `0.7.0` `PubkyAppFeed.fromJson`. The two-hop bitcoin vector uses `reach: "wot"`.

Additional Phase 0 gates (specs alone is not enough):

- `sort` / `content` / `reach` / `layout` equal to `likes` → `FEED_UNSUPPORTED_LIKES` (specs maps `content: "likes"` to `unknown` and would otherwise accept it)
- `reach: "followers"` → `FEED_UNSUPPORTED_REACH` (specs accepts it; the App mapper does not)

### `QueryResultV1` (`pubchi-query-result`)

Evidence envelope for “who tagged me?”, scoped to owner `U`:

- `items[]` with `label`, public `source_uri`, `subject_uri` under `U`, `claimant_count`
- `tool_trace_summary` (`tools`, `call_count`, `truncated`) — not raw tool payloads
- `scope_owner` must equal `owner`

Private data, session, key material, and raw provider prompt fields are rejected.

### Common envelope + Manifest

`CommonEnvelopeV1`: `schema`, `version`, `bot`, `owner`, `updated_at`.

`ManifestV1`: envelope plus `objects[]` of `{ path, schema, version, bytes, sha256 }`.

`OwnerBindingV1` is the U → B reciprocal object (`status`: `active` | `revoked`).

## Who consumes what

**Pubky App** (flagged `PUBKY_RUNTIME_PUBCHI_ENABLED`):

1. Writes `OwnerBindingV1` at `ownerBindingUri(U, B)` and sets `automation.operator = U` on B’s profile.
2. Signs `RequestObjectV1` with U (Ring) and writes `RequestBindingV1` under B.
3. Calls the Pubchi gateway with the signed object + body.
4. Validates `QueryResultV1` / `FeedProposalV1` before render. Feed Apply goes through existing `FeedController` only after `parseFeedProposalV1` succeeds.

**Pubchi service:**

1. Loads `TenantV1` from enrollment (not from the request body).
2. Verifies the request with `signer ?? asker`, then checks `DeviceDelegationV1` only for a signer device; legacy root-U requests remain accepted by default during the beta, and are rejected once the operator sets `PUBCHI_REQUIRE_DEVICE_SIGNER=1`.
3. Returns `QueryResultV1` or `FeedProposalV1`. Never stores keys, sessions, prompts, or private data.

## Out of scope (service-level Phase 0 proof gate 7)

These are not schema/verifier concerns and have no fixtures here:

- Scout outage
- Prompt injection

## Error codes

`SCHEMA_INVALID`, `VERSION_UNSUPPORTED`, `UNKNOWN_FIELD`, `FORBIDDEN_SECRET`, `FORBIDDEN_PRIVATE`, `FORBIDDEN_FINANCIAL`, `FORBIDDEN_SENSITIVE`, `FORBIDDEN_SURVEILLANCE`, `FORBIDDEN_INTERNAL`, `FORBIDDEN_ARBITRARY`, `INVALID_PUBKY`, `TIER_UNSUPPORTED`, `BRAIN_FORBIDDEN`, `BUDGET_NOT_FIXED`, `FEED_SPECS_INVALID`, `FEED_UNSUPPORTED_LIKES`, `FEED_UNSUPPORTED_REACH`, `REQUEST_MALFORMED`, `SIGNATURE_INVALID`, `REQUEST_EXPIRED`, `CLOCK_SKEW`, `NONCE_REPLAY`, `BODY_HASH_MISMATCH`, `ASKER_MISMATCH`, `BOT_MISMATCH`, `PURPOSE_UNSUPPORTED`, `PATH_FORBIDDEN`, `URI_FORBIDDEN`, `DELEGATION_NOT_FOUND`, `DELEGATION_INVALID`, `DELEGATION_EXPIRED`, `DELEGATION_PURPOSE_FORBIDDEN`, `DELEGATION_OWNER_MISMATCH`.

## Fixtures

`fixtures/valid/*.json` must parse (and verify when a sidecar `.meta.json` sets `verify: true`).

`fixtures/invalid/*.json` must fail with the `ERROR_CODE` in the filename (`kind__CODE__slug.json`). Verifier-only cases carry a `.meta.json`.

Regenerate: `npx tsx packages/pubchi-schemas/scripts/generate-fixtures.ts`.

## Gate proof

Negative evidence: the first hex digit of `signature` on `fixtures/valid/request-object__who-tagged-me.json` was flipped `9` → `8`. The fixture walk failed. The byte was restored. The walk passed.

### Corrupted (expect fail)

```
 ❯ packages/pubchi-schemas/src/fixtures.test.ts (31 tests | 1 failed) 59ms
   × fixture walk > parses valid/request-object__who-tagged-me.json 7ms
     → expected 'SIGNATURE_INVALID' to be 'ok' // Object.is equality

AssertionError: expected 'SIGNATURE_INVALID' to be 'ok' // Object.is equality
Expected: "ok"
Received: "SIGNATURE_INVALID"

 Test Files  1 failed (1)
      Tests  1 failed | 30 passed (31)
   Duration  573ms
```

### Restored (expect pass)

```
 ✓ packages/pubchi-schemas/src/fixtures.test.ts (31 tests) 26ms

 Test Files  1 passed (1)
      Tests  31 passed (31)
   Duration  358ms
```
