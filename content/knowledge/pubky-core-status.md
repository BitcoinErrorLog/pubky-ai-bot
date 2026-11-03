# Pubky Core status (as of 3 November 2026)

Pubky Core is the protocol layer: identity keys, PKARR discovery on the Mainline DHT, homeservers that store user data, and the SDKs apps use to talk to them.

## Homeserver and SDK

[pubky/pubky-homeserver](https://github.com/pubky/pubky-homeserver) (formerly pubky-core) contains the homeserver, the SDK, shared types and a local testnet. Latest release v0.17.1, 26 Oct 2026. The SDK is published as the Rust crate `pubky` 0.17.1 and the npm package `@synonymdev/pubky` 0.17.1.

What the homeserver does today:

- Public-key sign-up, sign-in and third-party app authorization (grants), with optional signup tokens.
- File storage over HTTP `PUT`, `GET`, `DELETE` and listing; public reads for anyone, writes with a session.
- Publishes its PKARR record so clients can find which homeserver holds a user's data.
- Event streams that indexers such as Nexus follow, plus admin and metrics endpoints for operators.

Recent additions from the release notes:

- v0.17.1: static website serving, admin `GET /users` routes, client IP from the TCP peer or PROXY protocol, typed SDK errors.
- v0.16.0 to v0.16.2 (12 to 15 Oct 2026): scoped encryption keys in grants, grant approvals encrypted with HPKE, custom grant proofs with offline verification, and selective approval of requested capabilities.
- v0.15.0 (7 Oct 2026): one session shared across browser tabs.

Related bindings: `@synonymdev/react-native-pubky` 0.15.0 (21 Oct 2026) for React Native, and [pubky-core-ffi](https://github.com/pubky/pubky-core-ffi) for native iOS and Android (no versioned release).

## Discovery and transport

- **PKARR** v8.1.0 (2 Oct 2026): signed DNS records for Ed25519 keys on the Mainline DHT, with HTTP relays. Packages: crate `pkarr` 8.1.0, `pkarr-relay` 2.1.0, npm `@synonymdev/pkarr` 8.1.0 ([releases](https://github.com/pubky/pkarr/releases)).
- **Mainline** v8.0.1 (30 Sep 2026): Rust client and node for the BitTorrent Mainline DHT ([repo](https://github.com/pubky/mainline)).
- **HTTP Relay** v0.7.0 (10 Mar 2026): store-and-forward relay with explicit acknowledgment, used by Pubky apps for sign-in hand-offs ([repo](https://github.com/pubky/http-relay)).
- **Pubky Noise** v0.1.0 (16 Oct 2026): encrypted peer-to-peer messages between two identities through their homeservers (Noise NN and XX patterns), with session backup and restore. Paykit uses it for private payment exchange ([repo](https://github.com/pubky/pubky-noise)).
- **pkdns** v0.7.1 (21 Jul 2025): DNS server that resolves PKARR domains. Its README says it is for development and experimentation, not production ([repo](https://github.com/pubky/pkdns)).

## Operator and developer tools

- [Pubky Backup](https://github.com/pubky/pubky-backup) v0.5.0 (20 May 2026): desktop app that keeps a local copy of a user's published data.
- [Pubky Umbrel app store](https://github.com/pubky/umbrel-app-store): community Umbrel store that hosts the homeserver as a beta app.
- [Homeserver Dashboard](https://github.com/pubky/homeserver-dashboard): web admin UI for operators (users, invites, files, logs).
- [Pubky Docker](https://github.com/pubky/pubky-docker): one-command local stack for development only.
- [Pubky App Templates](https://github.com/pubky/pubky-app-templates) and the [Ring Simulator](https://simulator.pubkyring.app/) for building and testing apps locally.
- [Pubky agent skills](https://github.com/pubky/agent-skills): skills for AI coding tools that cover the SDKs, data specs, auth flow and infrastructure.
- Experimental: [Pubky TLS Proxy](https://github.com/pubky/pubky-tls-proxy) v0.5.0 (raw-public-key TLS, RFC 7250) and [Pubky Chromium](https://github.com/pubky/pubky-chromium) (unsigned browser builds with PKDNS and raw-public-key TLS).

## Sources

- [pubky-homeserver releases](https://github.com/pubky/pubky-homeserver/releases)
- [Pubky knowledge base](https://pubky.org) ([source](https://github.com/pubky/pubky-knowledge-base-v2))
