# Pubky ecosystem status (as of 3 November 2026)

This page lists what is released or running in public today across Pubky and the Synonym stack, with the latest public version and date of each part. Versions come from GitHub releases, crates.io and npm on 3 November 2026. Newer releases may exist; check the linked release pages before quoting a version as current.

## Launched and in public use

| Component | What it does | Latest public version | Source |
| --- | --- | --- | --- |
| Pubky App | Social app at pubky.app: posts, tags, follows, feeds, collections, paid posts (Locks), Shop section | v1.12.0, 22 Oct 2026 | [releases](https://github.com/pubky/pubky-app/releases) |
| Pubky Homeserver | Per-user storage server with public-key sign-up, sign-in and app grants | v0.17.1, 26 Oct 2026 | [releases](https://github.com/pubky/pubky-homeserver/releases) |
| Pubky SDK | Rust crate `pubky`, npm `@synonymdev/pubky` | 0.17.1, 26 Oct 2026 | [crate](https://crates.io/crates/pubky), [npm](https://www.npmjs.com/package/@synonymdev/pubky) |
| PKARR | Signed DNS records for public keys on the Mainline DHT, plus relays | v8.1.0, 2 Oct 2026 | [releases](https://github.com/pubky/pkarr/releases) |
| Mainline | Rust BitTorrent Mainline DHT client and node | v8.0.1, 30 Sep 2026 | [releases](https://github.com/pubky/mainline/releases) |
| HTTP Relay | Store-and-forward message relay that Pubky sign-in links use to hand off grants | v0.7.0, 10 Mar 2026 | [releases](https://github.com/pubky/http-relay/releases) |
| Pubky Noise | Encrypted peer-to-peer messages between homeservers (Noise NN/XX) | v0.1.0, 16 Oct 2026 | [releases](https://github.com/pubky/pubky-noise/releases) |
| Pubky Ring | Mobile key manager that approves app access | v2.0, 5 Oct 2026 | [releases](https://github.com/pubky/pubky-ring/releases) |
| Pubky Passport | Browser signer with Continue with Google, at passport.pubky.app | v1.2.4, 21 Oct 2026 | [releases](https://github.com/pubky/pubky-passport/releases) |
| Pubky Nexus | Indexer and API behind feeds, search and tags (nexus.pubky.app) | live instance reports 0.4.1; last GitHub release v0.3.1, 20 Feb 2025 | [repo](https://github.com/pubky/pubky-nexus), [info](https://nexus.pubky.app/v0/info) |
| Nexus Scout | Read-only Cypher gateway for AI agents (nexus-scout.pubky.app) | no versioned release | [repo](https://github.com/pubky/nexus-scout) |
| Social data specs | Data formats for profiles, posts, tags, follows (crate and npm `pubky-app-specs`) | 0.8.1, 24 Sep 2026 | [releases](https://github.com/pubky/pubky-social-specs/releases) |
| Paykit | Payment discovery and private payment exchange over Pubky (`paykit-lib`, `paykit-sdk`, Swift and Kotlin bindings) | v0.1.0, 16 Oct 2026 (crates.io); v0.1.1-rc5, 2 Nov 2026 on GitHub | [releases](https://github.com/pubky/paykit-rs/releases) |
| Paykit Server | Receiver-side service that verifies payments for Locks invoices | v0.1.0, 17 Oct 2026 | [releases](https://github.com/pubky/paykit-server/releases) |
| Pubky Locks | Paid access to content on the creator's homeserver | v0.1.0, 17 Oct 2026; npm `@synonymdev/locks-sdk` 0.1.0 | [releases](https://github.com/pubky/locks/releases) |
| Pubky Market | Peer-to-peer shops and listings, at pubky.app/shop | data formats: `pubky-market-specs` v0.1.0, 31 Oct 2026 | [specs](https://github.com/pubky/pubky-market-specs/releases), [web client](https://github.com/pubky/pubky-marketplace) |
| Bitkit | Self-custodial Bitcoin and Lightning wallet with Pubky profiles and Paykit | v3.0.1 (iOS and Android), 21 Oct 2026 | [Android](https://github.com/synonymdev/bitkit-android/releases), [iOS](https://github.com/synonymdev/bitkit-ios/releases) |
| bitkit-core | Shared Rust core for the Bitkit apps | v0.7.0, 6 Oct 2026 | [releases](https://github.com/synonymdev/bitkit-core/releases) |

## How the parts fit

- A Pubky identity is an Ed25519 key. PKARR publishes a signed record for that key on the Mainline DHT that says which homeserver holds the user's data.
- The homeserver stores the user's files. Apps write with a session granted by the user (through Pubky Ring, Pubky Passport or Bitkit) and anyone can read public files.
- Pubky App writes social records in the social specs format. Nexus watches homeserver event feeds and indexes those records so the app can show feeds, search and tags.
- Paykit lets a wallet find where a Pubky identity can be paid and exchange private payment requests, receipts and subscriptions over Pubky Noise. Bitkit 3.0 ships it.
- Locks charges for access to content: a creator publishes a content lock, the viewer pays from a Paykit wallet such as Bitkit, Paykit Server reports the payment, and the Lock Server grants access.
- Pubky Market stores shops, listings and reviews on sellers' homeservers, indexes them with a dedicated marketplace Nexus, and coordinates checkout and orders in a transaction service. Buyers pay sellers directly; the Market does not hold funds.

## Regional availability of commerce

The published Pubky Terms of Service say that buying, selling and paid unlocks of digital content are not available in the European Union, the United Kingdom or the United States. The rest of the platform stays available there. Source: the Terms dialog in [pubky-app](https://github.com/pubky/pubky-app/blob/master/src/components/organisms/DialogTerms/DialogTerms.tsx), added in pubky-app v1.12.0.

## Public but not launched as a product

- `pubky-social-specs` 1.0.0-rc.1 (26 Oct 2026) is a prerelease of the next social data format. Pubky App v1.12.0 still uses `pubky-app-specs` 0.8.1.
- Locks v0.1.1-rc1 and Paykit Server v0.1.1-rc1 (28 Oct 2026) are prereleases.
- pkdns (v0.7.1, 21 Jul 2025) resolves PKARR domains; its README says it is for development and experimentation, not production.
- Pubky Chromium ships experimental, unsigned browser builds with PKDNS DNS-over-HTTPS and raw-public-key TLS. Pubky TLS Proxy (v0.5.0, 1 Oct 2026) adds raw-public-key TLS in front of existing web servers.
- Pubky Docker, the Ring Simulator (simulator.pubkyring.app) and Pubky App Templates are developer tools for local testing, not production hosting.
- The Pubky Umbrel app store hosts the homeserver as a beta community app; Homeserver Dashboard is an admin UI for operators.
- `pubky/pubky-chat` is a specification for encrypted chat kinds; it has no release.
- The Atomicity repository is a research proposal for peer-to-peer credit, not a product.

## Where to check for newer information

- Releases: each repository's GitHub releases page, crates.io and npm.
- Documentation: the Pubky knowledge base at [pubky.org](https://pubky.org) (source: [pubky-knowledge-base-v2](https://github.com/pubky/pubky-knowledge-base-v2)).
- Planned work: public issues and pull requests in each repository. See the roadmap-questions page.
