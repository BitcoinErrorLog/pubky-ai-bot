# Pubky apps and services status (as of 3 November 2026)

## Pubky App (pubky.app)

[pubky/pubky-app](https://github.com/pubky/pubky-app) is the social app at [pubky.app](https://pubky.app) and the reference app for the protocol. Latest release v1.12.0, 22 Oct 2026. It uses `@synonymdev/pubky` 0.16.2, `pubky-app-specs` 0.8.1 and `@synonymdev/locks-sdk` 0.1.0.

- Posts, articles, replies, tags on posts and profiles, follows, custom feeds ("perspectives"), bookmarks and collections. Data lives on each user's homeserver; Nexus indexes it for feeds and search.
- Sign-in with Pubky Ring, Bitkit (including on mobile) or Pubky Passport's Continue with Google.
- v1.12.0 added Locks paid posts and articles, a Shop section that embeds Pubky Market, and published Terms that restrict commerce features (buying, selling, paid unlocks) in the European Union, the United Kingdom and the United States.
- v1.11.0 (23 Sep 2026) added Google sign-in through Passport, installable PWA support, hashtags that become tags, and video link detection.

## Pubky Ring

[pubky/pubky-ring](https://github.com/pubky/pubky-ring) is the mobile key manager. It holds identity keys, lets users approve or revoke app access, and manages sessions without accounts or passwords. Latest release v2.0, 5 Oct 2026: DHT record republishing, sharing a pubky with Bitkit, and management of authorized grants. Installs: [pubkyring.app](https://pubkyring.app/).

## Pubky Passport

[pubky/pubky-passport](https://github.com/pubky/pubky-passport) is a browser signer at [passport.pubky.app](https://passport.pubky.app). Continue with Google creates a Pubky key in the browser, registers it with a homeserver and backs it up to the user's Google Drive. The secret key is created, encrypted and decrypted in the browser; neither Google nor the Passport server sees it. Recovery is 2-of-2 between Google and Passport: neither side can recover the key alone. Latest release v1.2.4, 21 Oct 2026.

## Homegate

[pubky/homegate](https://github.com/pubky/homegate) gates homeserver sign-ups for pubky.app. Its verification routes are optional per deployment: SMS, Lightning payment, IP and Google ID token checks. It has no public versioned release.

## Pubky Nexus and Nexus Scout

- [Pubky Nexus](https://github.com/pubky/pubky-nexus) indexes public social records from homeservers and serves feeds, search, tags and web-of-trust views to Pubky App. The public instance at nexus.pubky.app reports version 0.4.1 at [/v0/info](https://nexus.pubky.app/v0/info); the last tagged GitHub release is v0.3.1 (20 Feb 2025). The API uses the `/v0` prefix and is documented as unstable. Docs: [Swagger UI](https://nexus.pubky.app/swagger-ui/).
- [Nexus Scout](https://github.com/pubky/nexus-scout) at [nexus-scout.pubky.app](https://nexus-scout.pubky.app) lets AI agents run read-only Cypher queries over the social graph, without an account. It reads a periodically refreshed replica, so results can lag the Nexus API.

## Social data specs

[pubky/pubky-social-specs](https://github.com/pubky/pubky-social-specs) (formerly pubky-app-specs) defines profiles, posts, tags, follows, bookmarks, feeds and files. The stable line is `pubky-app-specs` 0.8.1 (24 Sep 2026) on crates.io and npm. `pubky-social-specs` 1.0.0-rc.1 (26 Oct 2026) is a prerelease of a new format with a migrator package; Pubky App does not use it yet.

## Sources

- [Pubky App releases](https://github.com/pubky/pubky-app/releases)
- [Pubky Ring releases](https://github.com/pubky/pubky-ring/releases), [Pubky Passport README](https://github.com/pubky/pubky-passport)
- [Pubky knowledge base](https://pubky.org) ([source](https://github.com/pubky/pubky-knowledge-base-v2))
