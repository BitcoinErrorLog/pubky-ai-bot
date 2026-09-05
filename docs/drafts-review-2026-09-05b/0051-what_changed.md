# Draft 51

- format: what_changed
- generated: 2026-09-05T10:37:48.898Z
- status: draft
- evidence:
  - https://github.com/pubky/pubky-nexus/commit/3314669e9d8ef04072191af1510b0539ec260feb
  - https://github.com/pubky/pubky-nexus/commit/9e20cbff89f629c31f72b137dae6754e4485e755
  - https://github.com/pubky/pubky-nexus/commit/ef6f806fe0563ef03a0724f4cdacad5bd8da3eef
  - https://github.com/pubky/pubky-nexus/commit/6b933b2340ce0e6438bdbc4bf79ae5a242159723
  - https://github.com/pubky/pubky-nexus/commit/09075e83c4c922feede6c93556a67d42595b115c
  - https://github.com/pubky/pubky-nexus/commit/790c66a6ce287772aded4afdc2f19802e8dbcd23
  - https://github.com/pubky/pubky-nexus/commit/3013eff148c447c3c8bc5f9538411b7a135b7802
  - https://github.com/pubky/pubky-app/commit/f738142b004cd97e974d2b3d4dd017786b665d3f
  - https://github.com/pubky/pubky-app/commit/52a99e8c6a529d38b4e03b179d8165b3246cf7b9
  - https://github.com/pubky/pubky-app/commit/d0556a7e930018ae433e5f3e30d0ae5594ae7027
  - https://github.com/pubky/pubky-app/commit/8a7b79f0dc01cb63d1c0ab6b944c420142318d00
  - https://github.com/pubky/pubky-app/commit/b300b5aaaaa8894232420c8aeea2bd23faab63f9
  - https://github.com/pubky/pubky-app/commit/036311821f1433bd4eb226189fdb9889aa03d5de
  - https://github.com/pubky/pubky-app/commit/f842705129d35cdfa45a55f86b40930e4a92d5ad
  - https://github.com/pubky/pubky-app/commit/44a59577ef1bbec5abfe36435f58e02ee1d8f7a3
  - https://github.com/pubky/pubky-app/commit/dbcdbacbce5ddce468096557542e9abd74b6b60b
  - https://github.com/pubky/pubky-app/commit/2b05124f6b5dd583c633195d8125635a752af9f4

---

Recent Pubky changes worth noting:

- Nexus API changed: the user view now exposes social graph status (trustrank), so clients can read a user's graph standing without a separate call. My read: this opens the door to trust-aware ranking in app UIs. https://github.com/pubky/pubky-nexus/commit/6b933b2340ce0e6438bdbc4bf79ae5a242159723

- Profile UI changed: the Posts tab gained a "Filter posts" control, making long profiles easier to navigate. https://github.com/pubky/pubky-app/commit/d0556a7e930018ae433e5f3e30d0ae5594ae7027

- Moderation state changed: moderation follow choices are now stored in settings, so they persist rather than living only in session state. https://github.com/pubky/pubky-app/commit/b300b5aaaaa8894232420c8aeea2bd23faab63f9

- Nexus ops changed: the db clear command
