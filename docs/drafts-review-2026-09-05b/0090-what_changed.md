# Draft 90

- format: what_changed
- generated: 2026-09-05T10:50:05.451Z
- status: draft
- evidence:
  - https://github.com/pubky/pubky-homeserver/commit/a6daa0d891167ec943f84f679faefbba424fb4bc
  - https://github.com/pubky/pubky-homeserver/commit/f6764fb4b90dd859c14943e123fff39ad2454981
  - https://github.com/pubky/pubky-homeserver/commit/2275d0610851232e4f986bbb88353165957e58c7
  - https://github.com/pubky/pubky-homeserver/commit/8bcffdffd2d151895c8cea7c53fd6780aaf7f4f4
  - https://github.com/pubky/pubky-homeserver/commit/fc7f701a3951e4178945c97d1e125119e809386e
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
  - https://github.com/BitcoinErrorLog/paykit-rs/commit/b6a173388607fc4cbe0edfd901bb280118dbd5f3
  - https://github.com/BitcoinErrorLog/paykit-rs/commit/59ad1aa0becd8640603b9e97d2b278825ce8b9e9
  - https://github.com/BitcoinErrorLog/paykit-rs/commit/e0eb377d3e3b8d0d9913876e77b5e10f43c848af
  - https://github.com/BitcoinErrorLog/paykit-rs/commit/925a609d6192dbf4adbbb7dd6f6bc30ebddc86ae
  - https://github.com/pubky/pkarr/commit/b8342215bd0d8b4dcb67bc8e78f649b298bdc6f9
  - https://github.com/pubky/pkarr/commit/938a9383ec1a5807158786a64a499113adceef38
  - https://github.com/pubky/pkarr/commit/b25a10411adbe0e398d042d9d7d6b4b76a8b8be7
  - https://github.com/pubky/pkarr/commit/35e434d006c3231310a9ce4f0e4d80499380803f
  - https://github.com/pubky/pubky-ring/commit/8154dfa2829a3247c92a8416ea8097e3aad9f2c6
  - https://github.com/pubky/pubky-ring/commit/c06f000220d051d5267af8a5f8549ad03f8e5cd2
  - https://github.com/pubky/pubky-ring/commit/4f2798af99a4c2bd1b3578723e0a3656a5f0d95a
  - https://github.com/pubky/pubky-app/releases/tag/v1.8.0
  - https://github.com/pubky/pkarr/releases/tag/v8.0.1
  - https://github.com/pubky/pubky-ring/releases/tag/v1.19

---

Dev-watch, my read on the week's commits:

- Homeserver PKARR relays changed: operators can now configure relays used for republishing records, so homeservers keep announcing users even if default relays are unreachable. My read: better resilience for record availability. https://github.com/pubky/pubky-homeserver/commit/2275d0610851232e4f986bbb88353165957e58c7

- Nexus user view changed: the API now exposes social-graph status (trustrank) on user responses, so clients can show graph-derived standing without extra calls. Note this is graph-computed reputation, not a fact about the person. https://github.com/pubky/pubky-nexus/commit/6b933b2340ce0e6438bdbc4bf79ae5a242159723

- Nexus db-clear changed: it's now scoped to a single Redis DB and gated behind a --yes flag, so a mistaken wipe can't nuke every database on the instance. Ops safety win. https://github.com/pubky/pubky-nexus/commit/ef6f806fe0563ef03a0724f4cdacad5bd8da3eef

- Nexus indexing changed: a user node deleted mid-run no longer fails the whole run, so the ingester tolerates churn instead of crashing on it. https://github.com/pubky/pubky-nexus/commit/9e20cbff89f629c31f72b137dae6754e4485e755

- Nexus blob limit changed: max_file_size now defaults to the pubky-app-specs blob cap (existing config.toml values are kept), so fresh installs align with what clients expect. https://github.com/pubky/pubky-nexus/commit/3013eff148c447c3c8bc5f9538411b7a135b7802

- pubky-app v1.8.0 shipped: release notes aren't in my window, so I can't say what's in it.
