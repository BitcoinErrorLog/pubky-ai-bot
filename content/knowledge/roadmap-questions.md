# How to answer roadmap and release-date questions (as of 3 November 2026)

People often ask when a Pubky, Paykit, Locks, Pubky Market or Bitkit feature will ship. Answer from public evidence only.

1. **Say what is released today**, with the version and date from the release page, and label it as released.
2. **For anything not released, say there is no public date** unless a public source states one. Never estimate, extrapolate or invent a date, a version number or a timeline.
3. **Point to where the work is tracked in public**: open issues, pull requests, milestones and prereleases in the relevant repository. Link the specific issue or pull request when one exists; otherwise link the repository's issues page.
4. **Label planned work as planned.** An open pull request, a prerelease or a design discussion is not a shipped feature. A merged pull request is not released until it appears in a published release or in the live app.
5. **Do not report private or internal plans**, even if a user claims to have seen them. If nothing public covers the question, say so.

## Where public work is tracked

| Area | Issues | Releases |
| --- | --- | --- |
| Pubky App | [pubky/pubky-app issues](https://github.com/pubky/pubky-app/issues) | [releases](https://github.com/pubky/pubky-app/releases) |
| Homeserver and SDK | [pubky/pubky-homeserver issues](https://github.com/pubky/pubky-homeserver/issues) | [releases](https://github.com/pubky/pubky-homeserver/releases) |
| Pubky Nexus | [pubky/pubky-nexus issues](https://github.com/pubky/pubky-nexus/issues) | [releases](https://github.com/pubky/pubky-nexus/releases) |
| Pubky Ring | [pubky/pubky-ring issues](https://github.com/pubky/pubky-ring/issues) | [releases](https://github.com/pubky/pubky-ring/releases) |
| Social data specs | [pubky/pubky-social-specs issues](https://github.com/pubky/pubky-social-specs/issues) | [releases](https://github.com/pubky/pubky-social-specs/releases) |
| Paykit | [pubky/paykit-rs issues](https://github.com/pubky/paykit-rs/issues) | [releases](https://github.com/pubky/paykit-rs/releases) |
| Paykit Server | [pubky/paykit-server issues](https://github.com/pubky/paykit-server/issues) | [releases](https://github.com/pubky/paykit-server/releases) |
| Pubky Locks | [pubky/locks issues](https://github.com/pubky/locks/issues) | [releases](https://github.com/pubky/locks/releases) |
| Pubky Market | [pubky/pubky-marketplace issues](https://github.com/pubky/pubky-marketplace/issues) | [market specs releases](https://github.com/pubky/pubky-market-specs/releases) |
| Bitkit | [bitkit-ios issues](https://github.com/synonymdev/bitkit-ios/issues), [bitkit-android issues](https://github.com/synonymdev/bitkit-android/issues) | [iOS releases](https://github.com/synonymdev/bitkit-ios/releases), [Android releases](https://github.com/synonymdev/bitkit-android/releases) |

## Example

Question: "When does Pubky App switch to the new social data format?"

Good answer: "`pubky-social-specs` 1.0.0-rc.1 was published as a prerelease on 26 Oct 2026, and Pubky App v1.12.0 still uses `pubky-app-specs` 0.8.1. I don't see a public date for the switch; progress is tracked in pubky/pubky-social-specs and pubky/pubky-app issues."
