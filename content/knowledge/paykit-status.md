# Paykit status (as of 3 November 2026)

Paykit lets a wallet or app find where a Pubky identity can be paid and exchange payment details privately. It is a discovery and coordination layer: it never moves funds or holds spending keys. The wallet chooses the payment method and executes the payment.

**The v0.1.0 release notes say: "Paykit is experimental and not for production use."** Bitkit 3.0 nevertheless ships it for contact payments, so describe it as released and in use, but experimental.

## Releases

- `paykit-lib` and `paykit-sdk` 0.1.0 on crates.io, GitHub release v0.1.0 on 16 Oct 2026 ([release](https://github.com/pubky/paykit-rs/releases/tag/v0.1.0)). The same release provides Swift bindings (Swift package at tag `v0.1.0`, `Paykit.xcframework`) and Kotlin bindings (`com.synonym:paykit-android:0.1.0` from the repository's GitHub Packages Maven registry). Check each release's notes and assets for the bindings it provides.
- v0.1.1-rc5, a release candidate, on GitHub on 2 Nov 2026. It adds accepting a counterparty's pending Allowance proposals in one batch ([release](https://github.com/pubky/paykit-rs/releases/tag/v0.1.1-rc5)).
- Landing page: [paykit.to](https://paykit.to).

## What it can do today

- **Public payment lists.** A payee registers each Paykit app in `/pub/paykit/v0/app-registry.json` on their homeserver and publishes payment endpoints under `/pub/paykit/v0/apps/{app_id}/endpoints/{identifier}`. Anyone with the payee's public key can read them.
- **Private payment lists.** Two identities open an Encrypted Link (built on [Pubky Noise](https://github.com/pubky/pubky-noise)) and the payee shares receiving details only with that counterparty.
- **Payment requests.** One-time or recurring requests, with responses and payment proofs.
- **Allowances.** Scoped consent for a wallet to pay qualifying requests from one sender automatically, within limits such as caps or expiry. An allowance is not a balance and gives the requester no custody.
- **Encrypted receipts.** The payee stores an encrypted receipt and shares access with the payer.
- Payment method identifiers are open-ended (for example on-chain Bitcoin, Lightning or other rails); support depends on the wallets on both sides ([identifier spec](https://github.com/pubky/paykit-rs/blob/master/specs/payment-endpoint-identifier.md)).

Requirements: homeserver 0.16.2 or newer. Shared-state recovery needs GCS storage on every serving homeserver instance ([README](https://github.com/pubky/paykit-rs#homeserver-requirements)).

## Where it is used

- **Bitkit 3.0** (iOS and Android, 21 Oct 2026): Pubky profiles, Paykit contacts, sending and requesting payments, and recurring subscriptions. Paykit contacts, requests and subscriptions are on by default. Bitkit 3.0.1 updated to Paykit 0.1.0.
- **Pubky Locks** paid unlocks: the viewer's Paykit wallet pays and Paykit Server confirms the payment.
- **Pubky Market** checkout uses Locks and Paykit for Bitcoin payments.

## Paykit Server

[pubky/paykit-server](https://github.com/pubky/paykit-server) v0.1.0 (17 Oct 2026) is a PostgreSQL-backed, receiver-side service for Locks invoices. It watches invoice-specific Bitcoin addresses and can verify direct USDT0 payments on Arbitrum One from Paykit ERC-20 proofs. Locks makes the access decision; the server never spends funds. Its README still describes the repository as pre-production: persisted-data compatibility and stable deployment support are not yet provided. v0.1.1-rc1 (28 Oct 2026) is a prerelease.

## Sources

- [paykit-rs README](https://github.com/pubky/paykit-rs) and [THESAURUS.md](https://github.com/pubky/paykit-rs/blob/master/THESAURUS.md)
- [Paykit on pubky.org](https://github.com/pubky/pubky-knowledge-base-v2/blob/main/src/content/docs/paykit.md)
- [Bitkit Android 3.0.0 release](https://github.com/synonymdev/bitkit-android/releases/tag/v3.0.0), [Bitkit iOS 3.0.0 release](https://github.com/synonymdev/bitkit-ios/releases/tag/v3.0.0)
