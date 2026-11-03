# Pubky Market status (as of 3 November 2026)

Pubky Market adds shops and product listings to Pubky. Sellers publish a catalog under their Pubky identity and buyers pay sellers directly. It runs inside Pubky App at [pubky.app/shop](https://pubky.app/shop); shop.pubky.app redirects to the embedded Market at pubky.app/shop-embed/marketplace. The pubky.app homepage advertises it as "Make a living: sell products on Pubky Market".

## What it can do today

- **Shops and listings** stored as public records on the seller's homeserver: physical and digital goods, variants, shipping options, fixed prices, auctions and drops (timed, limited releases).
- **Checkout and orders** coordinated by a transaction service that reserves stock, accepts offers, closes auctions and advances orders. A cached listing or a homeserver write alone cannot prove a reservation or payment.
- **Payments go to the seller.** The Market does not hold funds or refund from a platform balance. Bitcoin payments use [Pubky Locks](https://github.com/pubky/locks) and [Paykit](https://github.com/pubky/paykit-rs) with a Paykit wallet such as Bitkit. The web client's README also documents seller-direct PayPal. Which methods a buyer sees depends on the seller's setup and on region.
- **Digital delivery** of files, links or text after the payment is confirmed, with purchased content handled through Locks.
- **Reviews and receipts.** Reviews can carry a signed purchase attestation, and buyers get signed order receipts on their own homeserver, so the history survives without the operator.
- **Buyer and seller messages**, end-to-end encrypted and stored on the sender's homeserver.
- **Seller automation API** for inventory sync, order export, an event feed, webhooks and shipping updates ([API reference](https://github.com/pubky/pubky-marketplace-service/blob/main/docs/api.md)), with a TypeScript client and seller CLI published on npm as `@bitcoinerrorlog/pubky-shop` ([source](https://github.com/pubky/pubky-shop-sdk)).

Buying and selling are commerce features and are not available in the European Union, the United Kingdom or the United States under the published Pubky Terms of Service.

## Components

| Repository | Role | Version |
| --- | --- | --- |
| [pubky/pubky-market-specs](https://github.com/pubky/pubky-market-specs) | Data formats for shops, listings, drops, reviews, review responses, the private watchlist, order receipts and attestations; Rust crate and wasm npm package | v0.1.0, 31 Oct 2026 (pin the git tag; not on crates.io or npm) |
| [pubky/pubky-marketplace](https://github.com/pubky/pubky-marketplace) | Market web client, built on Pubky App | latest GitHub release shop-v0.6.53, 13 Oct 2026 |
| [pubky/pubky-marketplace-service](https://github.com/pubky/pubky-marketplace-service) | Rust transaction service for inventory, checkout, orders and payments | no versioned release |
| [pubky/marketplace-nexus](https://github.com/pubky/marketplace-nexus) | Marketplace indexer: upstream Pubky Nexus plus listing, shop, drop and review indexing | no versioned release |

The shared Pubky Nexus at nexus.pubky.app does not index Market records; the dedicated marketplace Nexus does. Market records use the paths `/pub/pubky.app/marketplace/v1/...` for public records and `/priv/pubky.app/marketplace/...` for private ones ([SPEC.md](https://github.com/pubky/pubky-market-specs/blob/main/SPEC.md)).

## Sources

- [Pubky Market on pubky.org](https://github.com/pubky/pubky-knowledge-base-v2/blob/main/src/content/docs/pubky-market.md)
- [pubky-market-specs README](https://github.com/pubky/pubky-market-specs)
- [pubky-marketplace README](https://github.com/pubky/pubky-marketplace)
- [Pubky App v1.12.0 release](https://github.com/pubky/pubky-app/releases/tag/v1.12.0) (Shop navigation and embed)
