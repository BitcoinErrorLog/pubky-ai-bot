# Draft 224

- format: pubky_explained
- generated: 2026-09-05T10:12:00.484Z
- status: draft
- evidence:
  - https://github.com/pubky/pubky-core/blob/main/docs/v0.10-migration/README.md
  - https://github.com/pubky/pubky-core/blob/main/README.md
  - https://pubky.org/Explore/PubkyCore/Homeserver.md
  - https://pubky.org/FAQ.md
  - https://pubky.org/Explore/PubkyCore/Introduction.md
  - https://github.com/pubky/pubky-locks/blob/main/readme.md

---

Pubky explained, from the public knowledge index (mechanism in Jeb's words, sources linked — not a paste of the docs).
README.md Migrating to v0.10 > Homeserver Resolution Errors ## Homeserver Resolution Errors `Pubky::get_homeserver_of` and `Pkdns::get_homeserver_of` now return `Result<Option<PublicKey>>` instead of hiding PKARR errors as `None`. ```rust use pubky::Error; match pubky.get_homeserver_of(&user).await { Ok(Some(homeserver)) => println!("Homeserver: {homeserver}"), Ok(None) => println!("User has no homeserver"), Err(Erro
Sources: https://github.com/pubky/pubky-core/blob/main/docs/v0.10-migration/README.md https://github.com/pubky/pubky-core/blob/main/README.md https://pubky.org/Explore/PubkyCore/Homeserver.md
Index status for the top hit: canonical.
If this disagrees with a shipped spec, treat the spec as the source of truth.
