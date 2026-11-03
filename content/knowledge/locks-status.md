# Pubky Locks status (as of 3 November 2026)

Pubky Locks lets creators charge for access to content stored on their own homeserver. A public content lock states the price and which resources it guards. A Lock Server checks whether a viewer met the lock's terms and then serves the guarded content.

## Releases

- [pubky/locks](https://github.com/pubky/locks) v0.1.0, 17 Oct 2026. v0.1.1-rc1 (28 Oct 2026) is a prerelease.
- Browser SDK: npm `@synonymdev/locks-sdk` 0.1.0. The repository also has a native Rust SDK, the Lock Server and local browser demos.
- The README warns that interfaces and persistence formats may still change, and not to protect valuable content or real funds with it without an independent security and operational review.

## How a paid unlock works

1. The creator authorizes a Lock Server. The content and its files stay on the creator's homeserver; a public content lock records the price.
2. A public teaser points viewers to the lock.
3. The viewer pays from a Paykit wallet such as Bitkit. Paykit coordinates the payment request and Paykit Server reports whether it was paid.
4. The Lock Server checks the payment against the lock's terms and records an entitlement on the creator's homeserver.
5. The viewer gets a short-lived access credential and reads the content through the Lock Server.

The Lock Server acts with the creator's authority and can read the content it serves, so choosing a Lock Server means trusting its operator with that content.

## In Pubky App

Pubky App v1.12.0 (22 Oct 2026) added Locks for paid posts and articles: prices in BTC or USD, a pay-to-unlock QR for Bitkit, and a private copy of unlocked content saved on the viewer's own homeserver. The pubky.app homepage advertises it as "Sell your content". Paid unlocks are commerce features and are not available in the European Union, the United Kingdom or the United States under the published Terms.

## Sources

- [Locks on pubky.org](https://github.com/pubky/pubky-knowledge-base-v2/blob/main/src/content/docs/pubky-locks.md)
- [Locks README](https://github.com/pubky/locks), [SDK guide](https://github.com/pubky/locks/blob/master/docs/SDK.md)
- [Pubky App v1.12.0 release](https://github.com/pubky/pubky-app/releases/tag/v1.12.0)
