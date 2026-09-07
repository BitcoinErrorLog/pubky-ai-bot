# `@pubky/pubchi`

Phase 0 read-only Pubchi gateway. Keyless, sessionless: it verifies signed
`RequestObjectV1` objects against public homeserver state and answers
`who-tagged-me` / `build-feed` within frozen budgets. Wire contracts live in
`@pubky/pubchi-schemas`.

## Threat model notes (device delegation)

### Authorization model (location, not owner signature)

A `DeviceDelegationV1` is authorized because it is published at
`pubky://U/pub/pubchi.app/devices/<D>.json`. Only a session that can write
U's `/pub/pubchi.app/` path can put it there. The gateway never checks an
owner signature and never opens a session; it only `GET`s that public URI
(`homeserver-read.ts`) and then:

- compares the `owner` *claim* to the URI owner (`DELEGATION_OWNER_MISMATCH`)
- verifies the `signature` as a **device self-signature** over the canonical
  unsigned object (`verifyPubkySignature(signer, …)` — D, not U)

Possession of the file on U's homeserver is the authorization. The device
signature only binds the bytes to D so a swapped document cannot name a
different key than the one that signed it.

### Enrollment-state oracle and fetch amplification (signer-bearing requests)

A request may carry an attacker-minted `signer` naming an arbitrary victim
`asker`. The signature verifies against the attacker's own key, so everything
after signature verification is attacker-reachable work.

- **One opaque code.** Until the signer is proven authorized by a verified
  `DeviceDelegationV1`, every post-signature authorization failure — not
  enrolled, wrong bot, asker/bot mismatch, missing/expired/forbidden/invalid
  delegation — returns the same `UNAUTHORIZED` (403) with a body of exactly
  `{ "error": "UNAUTHORIZED" }`. The precise reason is kept only in the
  server-side structured log (`cause`, e.g. `enrollment:TENANT_NOT_ENROLLED`,
  `delegation:DELEGATION_NOT_FOUND`). `UPSTREAM_UNAVAILABLE` (503) stays
  distinct because it reveals nothing about the victim. Root-signed callers
  (no `signer`, key ownership proven by the signature) keep the legacy codes.
- **Per-victim fetch budget.** Outbound homeserver fetches are token-bucketed
  per target `asker`/`owner` identity (`ASKER_FETCH_BURST = 4`, refill
  `ASKER_FETCH_RPS = 2/60s`), not per client IP — so one victim cannot be
  fanned out against no matter how many source IPs ask. Cache hits never
  consume the budget. Residual bound: **at most 4 fetches in a burst, then 2
  per 60s, per victim identity**.
- **Caching.** Positive delegation results: 15s (`DELEGATION_CACHE_MS`).
  Authoritative negatives (404 / unparsable doc): 60s
  (`DELEGATION_MISS_CACHE_MS`). Upstream blips: 30s
  (`DELEGATION_NEGATIVE_CACHE_MS` / `TENANT_NEGATIVE_CACHE_MS`). Enrollment
  results: 60s (`PUBCHI_TENANT_CACHE_MS`).
- **Memory caps.** Delegation cache: 1024 entries
  (`DELEGATION_CACHE_MAX_ENTRIES`); enrollment cache: 4096
  (`TENANT_CACHE_MAX_ENTRIES`); fetch-bucket key space: 10 000 keys. Expired
  entries are dropped on insert and the oldest entries are evicted beyond the
  cap, so attacker-chosen keys cannot pin memory.

### Revocation bound

Owner/bot/purpose/expiry are re-verified on every delegation cache hit, so the
only staleness is the cached document itself. After an owner revokes or
replaces a device delegation on their homeserver, the service honors the old
one for **at most 15s** (`DELEGATION_CACHE_MS`); the subsequent fetch observes
the revocation and the negative is cached for 60s. Delegation expiry itself is
enforced with the same 60s clock-skew allowance as the request path.

### Cutover switch

`PUBCHI_REQUIRE_DEVICE_SIGNER=1` rejects any request lacking a `signer`
(`UNAUTHORIZED`, 403). Default OFF (unset or any other value): legacy
root-signed requests stay accepted during the beta. This matches
`@pubky/pubchi-schemas` README exactly.

### Fail-closed library path

`verifyRequestObjectV1` (schemas package) has no delegation context and
rejects signer-bearing requests with `DELEGATION_INVALID`; only the
delegation-aware gateway path in this package authorizes device signers.
