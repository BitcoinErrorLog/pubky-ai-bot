# Bitkit status (as of 3 November 2026)

Bitkit is Synonym's self-custodial Bitcoin and Lightning wallet, built as native iOS and Android apps that share a Rust core. Website: [bitkit.to](https://bitkit.to).

## Releases

- [bitkit-ios](https://github.com/synonymdev/bitkit-ios/releases) and [bitkit-android](https://github.com/synonymdev/bitkit-android/releases): v3.0.0 and v3.0.1, both published 21 Oct 2026. v2.5.1 (14 Oct 2026) was the previous release.
- [bitkit-core](https://github.com/synonymdev/bitkit-core/releases) v0.7.0, 6 Oct 2026: shared Rust core with Swift, Kotlin and Python bindings.

## Pubky and Paykit in Bitkit 3.0

- Create or import a Pubky profile, including from Pubky sign-up links, and reuse a pubky already kept in Pubky Ring.
- Approve Pubky sign-in requests from web apps, such as signing in to pubky.app or connecting a Lock Server, with a dialog that names the requesting service and groups its permissions.
- Paykit contacts: add contacts from Pubky contact links, send and request payments, and see who a request is from and what it is for.
- Recurring subscriptions proposed to Paykit contacts; accepting one can send the first payment in the same swipe.
- Paykit contacts, payment requests and subscriptions are on by default. Bitkit 3.0.1 updated to Paykit 0.1.0.

## Other 3.0 features

- Opt-in USDT: send and receive with fees paid in USDT, Paykit contact payments and requests in USDT, cross-network deposits, and encrypted payment recovery backups. bitkit-core 0.7.0 adds the underlying USDT0 wallet on Arbitrum One.
- Blockstream Jade and Jade Plus hardware wallet pairing (Bluetooth on iOS; USB and Bluetooth on Android), alongside the existing Trezor support.
- Wallet recovery from Standard and Compact SeedQR codes.
- 3.0.1 fixes on both platforms: pending Pubky sign-ins survive another link opening, pending USDT payment protection survives a backup restore, and an on-chain payment whose request ended before broadcast can be cancelled so its coins return to the wallet.
- 3.0.1 on Android only: Pubky sign-in links while the profile loads, on-chain sends after an Electrum reconnect, and backup retries while Paykit is busy. On iOS only: on-chain payments no longer end with an unknown outcome after returning from the background, and payment links opened while locked open for review instead of paying with QuickPay.

## Related public repositories

- [synonymdev/ldk-node](https://github.com/synonymdev/ldk-node): Synonym's fork of LDK Node, the Lightning node library Bitkit uses; it publishes frequent release candidates.
- [synonymdev/bitkit](https://github.com/synonymdev/bitkit): architecture index for the Bitkit repositories.
- [synonymdev/bitkit-docker](https://github.com/synonymdev/bitkit-docker): local regtest Bitcoin and Lightning environment for development.

## Sources

- [Bitkit iOS 3.0.0 release](https://github.com/synonymdev/bitkit-ios/releases/tag/v3.0.0), [Bitkit Android 3.0.0 release](https://github.com/synonymdev/bitkit-android/releases/tag/v3.0.0), [Bitkit Android 3.0.1 release](https://github.com/synonymdev/bitkit-android/releases/tag/v3.0.1)
- [bitkit-core v0.7.0 release](https://github.com/synonymdev/bitkit-core/releases/tag/v0.7.0)
