# External-resource configuration

External-resource discovery is a deterministic, staging-only operation. It reads a bounded JSON batch, applies the versioned registries, and emits accepted and rejected decisions plus aggregate counts. Shadow mode never publishes, calls Nexus, or creates a per-object approval queue. Publish mode (`JEB_RESOURCE_MODE=publish` or `--mode publish`) is allowed only with `JEB_RESOURCE_TARGET=staging` and writes one universal tag file per accepted label to the staging homeserver.

`JEB_RESOURCE_APP` (default `jeb.pubky.app`) is the homeserver app path segment. A tag is a *universal tag* only when it is stored at `/pub/<app>/tags/<tag_id>` with `<app>` **not** equal to `pubky.app`. Writing under `/pub/pubky.app/tags/` creates an ordinary pubky.app tag and no Nexus Resource. The app name must be a single path segment matching pubky-app-specs `try_parse_pubky_path` / `TagPath::parse` (nonempty, not `pubky.app`, no slashes).

The tag JSON body is `{ uri, label, created_at }`. `uri` is Jeb's `normalizeUri` result so Nexus `resource_id = hex(BLAKE3(normalize_uri(uri))[0..16])` agrees. `tag_id` is Crockford-base32 of the first half of BLAKE3(`{uri}:{label}`), as in pubky-app-specs `HashId` for `PubkyAppTag`. Re-running the same batch GETs each path and skips identical uri+label (idempotent; 0 writes).

Every PUT is gated to the staging homeserver public key `ufibwbmed6jeq9k4p583go95wofakh9fwpp4k734trq79pd9u1uy` (`homeserver.staging.pubky.app`). In publish mode `JEB_HOMESERVER` must equal that public key (config/CLI) and the session's resolved homeserver (`Signer.pkdns.getHomeserver()` after `signin()`/`signup()`) must match it before the first PUT. Production hosts (`homeserver.pubky.app`, `nexus.pubky.app`) are refused. A production `JEB_RESOURCE_TARGET` fails at config load. A run may issue at most 300 tag writes (accepted records × labels); over that cap the run is rejected, not truncated. GET-then-PUT is not conditional (no If-Match on session `putJson`); staging publish is a single-writer identity.

The publisher writes a per-run manifest (configVersion, app, target, written / skipped_existing / failed, and each write's normalized uri, resourceIdentity, label, tag path). No secrets or session tokens. One failed PUT does not abort the batch; a nonzero process exit means at least one write failed.

## Versioned source registry

## Versioned source registry

`RESOURCE_CONFIG_VERSION` identifies the configuration contract. Every accepted and rejected provenance record carries the caller's `configVersion`; the resources role supplies `JEB_RESOURCE_CONFIG_VERSION` (default `external-resources-v2`) so an operator can attribute decisions to a configuration revision.

Each source entry has an id, priority tier and score, the families it can yield, freshness window, polling cadence, cost ceiling, robots posture, licensing posture, an enabled flag, an unmatched policy, and an optional `allowIdnHosts` override. `reject` drops URLs without a matching rule with `no taxonomy match`; `source-default` permits the source's explicitly configured operator labels as subject tags. Crawler sources use `reject`, so `--label` is never a universal documentation label. The classifier rejects an IDN (`xn--`) host below a curated `hostSuffix` with `idn host under curated domain` unless that source explicitly sets `allowIdnHosts: true`.

Disable a source without code by setting `JEB_RESOURCE_DISABLED_SOURCES` to a comma-separated list of source ids. Disable an entire object family with `JEB_RESOURCE_DISABLED_FAMILIES` using `url`, `geocoordinate`, or `stable-identifier`. These switches are evaluated before acceptance and do not truncate a batch.

## Object families and identity

The URL family reuses the exported URL entry point, whose normalization follows the upstream Nexus universal-resource contract: lowercase scheme and host, remove default ports, fragment, and userinfo, preserve path and query byte order, and serialize an empty path as `/`. Opaque schemes such as `nostr:` use the RFC 3986 scheme fallback; `ipfs://` and other non-`pubky://` URIs remain external resources.

Geocoordinates use `geo:<latitude>,<longitude>` with validated decimal-degree ranges and normalized signed decimal values. Stable identifiers currently cover DOI, ISBN-10/ISBN-13, Nostr event ids, Bluesky AT URIs, and npm/PyPI package identifiers. DOI and ISBN forms are normalized before being represented as URI-like identities; Nostr and other URI schemes use the upstream URI normalizer. Unsupported identifier forms are rejected rather than assigned a placeholder identity.

Resource ids are the first 16 bytes of BLAKE3 over the normalized URI, rendered as 32 lowercase hexadecimal characters. No family prefix is added to the id.

## Taxonomy composition

Taxonomy is composed from domain, type, subject, geography, and source-status tags by the ordered additive rule table in `src/resource-classify.ts`. Rules match host, host suffix, path, title, and source. Matching strips all leading `www.` labels only for rule lookup; canonical URI and identity remain unchanged. Reject rules are checked against both ASCII and Unicode host forms and apply to the named host and its subdomains. A rule may set `reject: true` to create an explicit exclusion with reason `excluded by rule`; it is still counted in `byRule`. Output is deterministic and capped at five labels in domain, type, subject, geography priority order. After validation and capping, an empty final label set is rejected with `no publishable labels`, including an unmatched `source-default` source with no defaults. Music hosts emit `music` plus a typed label such as `music-track`; an unrecognizable music URL is rejected with `music host has no recognisable type`. Malformed labels are rejected by the existing bot-kit tag policy.

## Decisions and shadow reporting

The stable sort key is source priority, source id, and raw value. Score is `source priority + matched rule weights + metadata completeness + freshness + path specificity - generic-news-homepage penalty`. The path-specificity bonus is higher for a recognized typed path than for a homepage. Duplicate normalized identities are rejected after the highest-priority deterministic candidate is considered. The same values and configuration version produce the same identity, score, tags, and decision.

The hard record cap is 100 both for the requested limit and input batch. A batch over 100 fails closed before iteration; a limit outside 1–100 fails closed. The shadow report contains aggregate counts by source, family, tag, rejection reason, and rule id (`byRule`). Accepted resources use the first matched domain as their category; `pubky` remains the requested run category for staging compatibility.
A publish run that would issue more than 300 tag writes (records × labels) fails closed.

## Deliberately excluded

Content-addressed ids such as arbitrary CIDs, broad package ecosystems beyond npm/PyPI, and free-form music metadata are not registered because this slice does not yet have a complete, tested canonical form for them. They must not be added by treating a raw string as canonical.
