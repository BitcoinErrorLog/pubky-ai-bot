# External-resource configuration

External-resource discovery is a deterministic operation over a bounded JSON batch. It applies the versioned registries and emits accepted and rejected decisions plus aggregate counts. Shadow mode never publishes, calls Nexus, or creates a per-object approval queue. Publish mode (`JEB_RESOURCE_MODE=publish` or `--mode publish`) writes one universal tag file per accepted label, and is a dry run that performs zero writes until `--execute` is also passed.

Two targets exist: `staging`, the pilot publisher, and `production`, Jeb's own identity. Production is gated separately and has its own runbook in `docs/production-gate.md`. Everything below applies to both targets unless it names one.

Each run selects exactly one command family (`discover`, `crawl`, `places`, `canon`, `pubky-posts`). Two family selectors, a repeated selector, or a flag belonging to another family is refused before any file, network, or database access.

URLs and public keys for a resource run come only from the compiled target profile in `src/resource-target-profile.ts`: the Nexus URL, the homeserver public key and host, the expected publisher, and the pubkyauth relay. `JEB_NEXUS_URL` still configures other roles, but a resource run ignores it.

Every build writes `dist/build-stamp.json` with the resource config version, the pin-set version, the git commit, and a hash of the deployed `dist` tree. The runtime hashes the same `dist` tree and compares, so the stamp verifies what Node actually executes rather than a source tree the image does not ship. The stamp deliberately carries no target: one immutable image serves both targets, and the target is authorized at runtime instead. Publish and reconcile (including dry runs) refuse a missing, malformed, or stale stamp; shadow mode warns and continues.

`JEB_RESOURCE_APP` (default `jeb.pubky.app`) is the homeserver app path segment. A tag is a *universal tag* only when it is stored at `/pub/<app>/tags/<tag_id>` with `<app>` **not** equal to `pubky.app`. Writing under `/pub/pubky.app/tags/` creates an ordinary pubky.app tag and no Nexus Resource. The app name must be a single path segment matching pubky-app-specs `try_parse_pubky_path` / `TagPath::parse` (nonempty, not `pubky.app`, no slashes).

The tag JSON body is `{ uri, label, created_at }`. `uri` is Jeb's `normalizeUri` result so Nexus `resource_id = hex(BLAKE3(normalize_uri(uri))[0..16])` agrees. `tag_id` is Crockford-base32 of the first half of BLAKE3(`{uri}:{label}`), as in pubky-app-specs `HashId` for `PubkyAppTag`. Re-running the same batch GETs each path and skips identical uri+label (idempotent; 0 writes).

Every PUT is gated to the selected target's pinned homeserver: staging `ufibwbmed6jeq9k4p583go95wofakh9fwpp4k734trq79pd9u1uy` (`homeserver.staging.pubky.app`), production `8um71us3fyw6h8wbcxb5ar3rwusy1a6u49956ikzojg3gcwd1dty` (`homeserver.pubky.app`). The pin comes from the compiled target profile, never from the environment: `JEB_HOMESERVER` is forbidden by name in every executor process (staging included), and the session's resolved homeserver (`Signer.pkdns.getHomeserver()`) must match the profile pin before the first PUT. A cross-target pairing — a production target on the staging homeserver, or the reverse — is refused. Both modes require `--expected-pk` to equal the target profile's publisher; there is no silent fallback. A run may issue at most 1000 tag writes or deletes (hard record cap 100 × 10 labels per resource); over that cap the run is rejected, not truncated. GET-then-PUT is not conditional (no If-Match on session `putJson`); each publisher identity is a single writer, enforced by a process-local file lock and, for production, a PostgreSQL advisory lock keyed by the publisher.

The publisher writes a per-run manifest (configVersion, app, target, whether it executed, the plan hash, written / skipped_existing / failed, and each write's normalized uri, resourceIdentity, label, tag path). Failures record a bounded error code from a fixed vocabulary, never a thrown message: an SDK or homeserver error can carry a request URL or a header. No secrets or session tokens. The first failed PUT aborts the batch — no later mutation follows a failed predicate — and a nonzero process exit means at least one write failed.

The `data/resource-cache` directory and files are assigned `0700` and `0600` modes by syscalls, but those modes cannot be verified on exFAT/noowners volumes such as the development drive. Production hosts must use a POSIX filesystem.

## Versioned source registry

`btcmap-places` is the P3 place adapter. It reads the full v4 chronological
sync at `https://api.btcmap.org/v4/places?fields=...&updated_since=<cursor>&include_deleted=true&limit=1000`
until the cursor reaches the tip. The CDN snapshot
(`https://cdn.static.btcmap.org/api/v4/places.json`) currently contains only
compact `id`, `lat`, `lon`, and `icon` fields, so it is retained as the
documented lightweight fallback, not the tagging input. The v4 sync pins
`id`, `name`, `lat`, `lon`, `updated_at`, `verified_at`, `boosted_until`,
`deleted_at`, `osm_id`, `website`, `opening_hours`, and relevant `osm:*`
fields. Missing city/country values are resolved through
`https://api.btcmap.org/v4/areas?lat=<lat>&lon=<lon>`; `type=country` and
`type=community` memberships supply the fallback country and city labels.
The full pool and area membership cache with mode 0700 for the directory and
0600 for files. Read egress is limited to `api.btcmap.org`,
`cdn.static.btcmap.org`, and `www.openstreetmap.org`; homeserver write egress
is unchanged.

`RESOURCE_CONFIG_VERSION` identifies the configuration contract. Every accepted and rejected provenance record carries the caller's `configVersion`; the resources role supplies `JEB_RESOURCE_CONFIG_VERSION` (default `external-resources-v3-bitcoin-canon`) so an operator can attribute decisions to a configuration revision. A production run may not use that default: it requires an explicit `JEB_RESOURCE_CONFIG_VERSION` equal to the signed production version compiled into the build (see `docs/production-gate.md`).

## Spend ceilings

`JEB_RESOURCE_RUN_USD_CAP` (default 2) bounds one invocation and `JEB_RESOURCE_DAILY_USD_CAP` (default 5) bounds one UTC day per target. The publisher reads both from config and contains no dollar literals of its own; the run cap may not exceed the daily cap.

Every completed model or cache step must report a finite, non-negative cost. A cache hit reports an explicit zero. Absent metering is a failure, never a zero, because treating it as zero is how a run outspends its cap: the current resource is not published, no later resource is attempted, the manifest records the terminal totals and the unprocessed count, and the process exits nonzero.

The keyless planner (`--mode plan`) reserves its estimate against the UTC-day row before any model, Nexus, or fetch call, using the greater of the per-resource estimate compiled into the target profile (`perResourceEstimateUsd`) and the observed recent average for the same family, times the requested limit, clamped to the run cap. The check and the reservation are one conditional statement, so two concurrent runs cannot both read a day under the cap and then both reserve. No transaction is ever held across external I/O. Every model call and every cache hit is metered against the reservation as the run proceeds (a cache hit is an explicit zero), and actual spend is settled at termination.

Each run row carries a bounded lease (default 15 minutes, renewed by heartbeat during the run). A process killed mid-run stops renewing; a reaper at the start of the next run closes the expired `running` row as `abandoned`. An abandoned row is never silently reused — late settlement and heartbeats against it fail — and its day-row reservation is not released: freeing reserved dollars without terminal-manifest proof is how a crashed run outspends the daily cap. Releasing a crashed reservation stays an operator action (see `docs/production-gate.md`).

## Pubky posts

Run `--role resources --source pubky-posts --mode shadow --limit 40` to evaluate posts from staging Nexus. Pools are evaluated in order: engaged long/link posts, already-tagged posts, posts under `/v0/tags/hot`, then the last 24 hours. The adapter writes the exact `pubky://<author>/pub/pubky.app/posts/<id>` URI and records the pool, existing tags, linked URL, and score components in provenance. Replies, reposts, new authors, posts younger than 15 minutes, authors who muted the pilot publisher, and short non-link posts are counted as rejections. DMs are not on Nexus and cannot enter the candidate set.
When tagger identities are present, labels whose only tagger is the publisher are excluded from post hints; the generic Nexus resource-tag adapter currently returns bare labels, so it cannot apply that publisher-specific filter.

The upstream Nexus route currently exposes no muted-list endpoint in `nexus-webapi/src/routes/v0`. The adapter uses the unauthenticated public homeserver reader and checks `pubky://<author>/pub/pubky.app/mutes/<publisher_pk>`: status 200 rejects with `author-muted-publisher`, 404 continues, and a read/network error rejects with `mute-check-failed`. Results are cached per author for the run. Discovery requests are capped at `limit × 4 + 265`, where 265 is the maximum stream-page count (24 pool pages × 11 pages) plus the hot-tag request; discovery stops and records `discovery-request-budget` when the cap is reached. The CLI uses Nexus profile timestamps for the seven-day author-age check.

Place identity is the OSM permalink
`https://www.openstreetmap.org/{node|way|relation}/{id}`, matching mapky.
Provenance records latitude and longitude rounded to six decimals, OSM
version, BTC Map `updated_at`/`verified_at`, and
`© OpenStreetMap contributors (ODbL); BTC Map`. The API server is AGPL, but
that licence does not bind consumers of the OSM-derived data; ODbL attribution
requirements still apply to republished place data.

The adapter excludes `deleted_at`, missing names, unknown OSM types, missing
coordinates, and places whose OSM tags contain a `disused:*` key or whose
`opening_hours` is `off`, `closed`, or `permanently closed`. It prioritises
recent verification/update, city density, and source priority, and limits
each country to 40% of a run. Place hints are model data, not forced labels:
`bitcoin-accepted`, payment capabilities, amenity/shop/tourism, cuisine, city,
and country.


Each source entry has an id, priority tier and score, the families it can yield, freshness window, polling cadence, cost ceiling, robots posture, licensing posture, an enabled flag, an unmatched policy, and an optional `allowIdnHosts` override. `reject` drops URLs without a matching rule with `no taxonomy match`; `source-default` permits the source's explicitly configured operator labels as subject tags. Crawler sources use `reject`, so `--label` is never a universal documentation label. The classifier rejects an IDN (`xn--`) host below a curated `hostSuffix` with `idn host under curated domain` unless that source explicitly sets `allowIdnHosts: true`.

Disable a source without code by setting `JEB_RESOURCE_DISABLED_SOURCES` to a comma-separated list of source ids. Disable an entire object family with `JEB_RESOURCE_DISABLED_FAMILIES` using `url`, `geocoordinate`, or `stable-identifier`. These switches are evaluated before acceptance and do not truncate a batch.

`bitcoin-canon` is the versioned reference-shelf adapter for BIPs, BOLTs,
Bitcoin Optech topics/newsletters, bitcoin-dev and Delving Bitcoin threads,
papers, and immutable block/transaction anchors. Run it with
`--role resources canon --source bitcoin-canon`. Its live fetches use the
shared resource fetch gate (robots, HTTPS, DNS/private-host checks, and
same-host pacing); discovery is shadow-only unless the existing staging
publisher mode is explicitly selected. Canonical forms and the source
configuration version are exported from `src/resource-canon.ts`.
Withdrawn, rejected, and obsolete BIPs are excluded by default; the
operator may explicitly pass `--include-withdrawn` for a research run.
Time-anchor discovery uses the guarded fetch gate for
`https://mempool.space/api/block-height/<height>` and requires `text/plain`.
Paper seeds are peer-reviewed Bitcoin references identified by DOI. Each
Crossref response is checked against its configured seed title using
case/punctuation-insensitive token overlap; a mismatch is rejected as
`doi-title-mismatch` before classification or model tagging. The gnusha
adapter emits only message permalinks, never inbox navigation or Atom URLs,
and BIP parsing emits one extension-preserving URL per BIP number.
The canon run has a 200-request budget by default. The budget is
`index_count + crossref_count + halving_count + selected_page_count`: each
enabled source index contributes one request (up to five with the current
BIP, BOLT, two Optech, and mailing-list adapters), Crossref contributes one lookup per seeded paper, each configured
halving height consumes one request, and every selected newsletter, topic,
or mailing-list message page consumes one request. A caller-supplied
`maxRequests` is enforced before each request, including Crossref. The
default ceiling covers a limit-100 run with the current eight papers,
four halving lookups, and candidate fan-out. Block-height requests use the
existing 14-day index cache because block hashes at fixed heights are
immutable.
Candidate caps round-robin across non-empty sub-sources in priority order, then
fill remaining slots by global score; a limit above the inventory selects all
candidates.

## Object families and identity

The URL family reuses the exported URL entry point, whose normalization follows the upstream Nexus universal-resource contract: lowercase scheme and host, remove default ports, fragment, and userinfo, preserve path and query byte order, and serialize an empty path as `/`. Opaque schemes such as `nostr:` use the RFC 3986 scheme fallback; `ipfs://` and other non-`pubky://` URIs remain external resources.

Geocoordinates use `geo:<latitude>,<longitude>` with validated decimal-degree ranges and normalized signed decimal values. Stable identifiers currently cover DOI, ISBN-10/ISBN-13, Nostr event ids, Bluesky AT URIs, and npm/PyPI package identifiers. DOI and ISBN forms are normalized before being represented as URI-like identities; Nostr and other URI schemes use the upstream URI normalizer. Unsupported identifier forms are rejected rather than assigned a placeholder identity.

Resource ids are the first 16 bytes of BLAKE3 over the normalized URI, rendered as 32 lowercase hexadecimal characters. No family prefix is added to the id.

## Controlled subject vocabulary

`src/resource-vocabulary.ts` contains the versioned (`VOCABULARY_VERSION`) controlled subject vocabulary. Each entry has an id, one or more domains, and aliases. A subject id must satisfy the same lowercase label policy as every other published tag and may be no longer than 20 characters. To add a subject, add a declarative entry with at least two useful aliases where natural; do not infer labels by copying arbitrary words from page content.

The deterministic matcher examines the title (weight 3), URL path slug (weight 2), description (weight 1), and `site_name` (weight 1). Matching is normalized with lowercase/NFKC/diacritic removal and uses whole words or phrases, with at most three occurrences per field. Results are ordered by score and then vocabulary order. Subjects whose domains do not overlap rule-emitted domains remain eligible at half score, allowing strongly described cross-domain material without making a bare host look topical.

The provenance `subjectMatches` list records each matched id, score, and source fields. A published subject label is always either a vocabulary id or a rule-table emission; page text is never itself a label. This invariant keeps free-form content from becoming an uncontrolled tag namespace and leaves a clean boundary for a future model-assisted stage.

## Taxonomy composition

Taxonomy is composed from domain, type, subject, geography, and source-status tags by the ordered additive rule table in `src/resource-classify.ts`. Rules match host, host suffix, path, title, and source. Matching strips all leading `www.` labels only for rule lookup; canonical URI and identity remain unchanged. Reject rules are checked against both ASCII and Unicode host forms and apply to the named host and its subdomains. A rule may set `reject: true` to create an explicit exclusion with reason `excluded by rule`; it is still counted in `byRule`. Output is deterministic and capped at ten labels in domain, type, subject, geography priority order. After validation and capping, an empty final label set is rejected with `no publishable labels`, including an unmatched `source-default` source with no defaults. Music hosts emit `music` plus a typed label such as `music-track`; an unrecognizable music URL is rejected with `music host has no recognisable type`. Malformed labels are rejected by the existing bot-kit tag policy.

## Decisions and shadow reporting

The stable sort key is source priority, source id, and raw value. Score is `source priority + matched rule weights + metadata completeness + freshness + path specificity - generic-news-homepage penalty`. The path-specificity bonus is higher for a recognized typed path than for a homepage. Duplicate normalized identities are rejected after the highest-priority deterministic candidate is considered. The same values and configuration version produce the same identity, score, tags, and decision.

The hard record cap is 100 both for the requested limit and input batch. A batch over 100 fails closed before iteration; a limit outside 1–100 fails closed. The shadow report contains aggregate counts by source, family, tag, rejection reason, rule id (`byRule`), label-count histogram (`labelsPerResource`), and subject frequency table (`topSubjects`). Accepted resources use the first matched domain as their category; `pubky` remains the requested run category for staging compatibility.
A publish or reconcile run that would issue more than 1000 tag writes or deletes (records × labels) fails closed.

## Deliberately excluded

Content-addressed ids such as arbitrary CIDs, broad package ecosystems beyond npm/PyPI, and free-form music metadata are not registered because this slice does not yet have a complete, tested canonical form for them. They must not be added by treating a raw string as canonical.
