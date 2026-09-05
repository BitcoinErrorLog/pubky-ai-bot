# Pubchi: definitive Stage 4 design

**Status:** design for implementation
**Roadmap position:** Rise of the Robots, Stage 4
**Date:** 2026-09-05
**Working repository:** `/Volumes/vibedrive/vibes-dev/pubky-ai-bot-pubchi`

This design replaces the stale Stage 4 draft in
`/Volumes/vibedrive/vibes-dev/.cursor/plans/jeb_rise_of_the_robots_9c1e4b27.plan.md`
without modifying that plan. It treats Collections as shipped.

## 1. **Summary**

Pubchi is a user-owned, graph-aware personal bot. It has its own Pubky identity,
its own profile, its own public reputation, and its own bounded authority. The
person talks to it in Pubky App; Pubchi turns that intent into typed Nexus/Scout
reads, feed definitions, settings proposals, tag suggestions, drafts, or—only
after a separate grant—posts and tags authored by the bot.

The user receives six useful things at launch:

1. concise summaries of a feed, thread, or period of activity;
2. “what did I miss?” based on an explicit cursor rather than an engagement
   algorithm;
3. natural-language creation and editing of existing `PubkyAppFeed` objects;
4. attributable tag suggestions using the Tagky capability boundary;
5. evidence-shaped graph insights scoped to the user's follow graph; and
6. conversational control of the same settings and permissions exposed in UI.

The model is not the durable product. The durable actor is:

- a bot key generated and recoverable in Ring;
- a bot profile at
  `pubky://<bot>/pub/pubky.app/profile.json`;
- a reciprocal owner binding at
  `pubky://<owner>/pub/pubchi.app/bots/<bot>.json`;
- portable, versioned configuration under
  `pubky://<bot>/pub/pubchi.app/`;
- scoped homeserver sessions which can be listed, expired, and revoked; and
- ordinary Pubky posts and tags whose author is the bot key.

The user's root key never leaves Ring. The hosted service never receives a user
key or a bot key. In assisted mode it returns drafts to Pubky App's local
approval queue; only an explicit background-suggestions option stores public
bot suggestions. Pubky App publishes approved user-authored objects through the
user's existing local session. In autonomous mode the hosted publisher may use
a revocable session for the **bot identity**, never the user identity. That
distinction preserves authorship, reputation, and blast radius.

The first shipping increment is deliberately smaller: read-only Pubchi on
staging, behind an App feature flag, with no hosted homeserver session. One
engineer can prove in one week that a question can be bound to a bot/owner,
answered through Bot Kit NLQ and Scout, rendered in App, and converted into a
validated feed preview without any server-side write authority. Autonomous
publication is not on that critical path.

This is not a private assistant yet. Homeserver `/priv/` storage is not
implemented. Every Stage 4 memory object is therefore public by construction,
the schema excludes secrets, and the UI says “Public bot memory” at the point of
entry. Conversation transcripts, credentials, private notes, private messages,
and detailed behavioral logs are not stored. Private memory is a later storage
migration, not a promise hidden behind public JSON.

Pubchi reuses Jeb's proven deterministic shell:

- Bot Kit typed Nexus and Scout tools;
- the schema-aware NLQ planner;
- fail-closed budgets and policies;
- independent consumption, generation, Scout, web, replies, and proactive
  switches;
- prompt/tool screening and the final outbound secret gate;
- idempotent publish requests; and
- publisher isolation.

It does **not** reuse Jeb's key-loading model. Jeb can sign in after a restart
because its publisher holds Jeb's key. Pubchi uses no hosted session in the
default read-only or synchronous assisted paths. If the user enables hosted
background suggestions or autonomous publication, Pubchi receives a bot
session through Ring and persists only that bearer session in a dedicated
session broker. If the session expires or is revoked, writes stop and the user
is asked to re-authorize. There is no key fallback.

The success criterion is not chat volume. It is useful work with less repeated
inference: feeds created, summaries accepted, settings proposals applied,
suggestions rejected safely, and durable bot artifacts reused—with every claim,
action, source, and authority boundary inspectable.

## 2. **Ground truth**

### Pubky App

Collections have shipped. They are `PubkyAppPost` objects with
`kind = collection`; their typed JSON content contains `name`, `description`,
ordered `items`, optional `cover_image`, and optional `layout`. App validation,
add/remove, and concurrency-aware reorder logic are in
`pubky-app/src/core/pipes/post/post.collection.ts`; the spec implementation is
`pubky-app-specs/src/models/post/content/collection.rs`. The stale Stage 4
“Collections shipped” precondition must therefore be removed.

Custom feeds also exist. `FeedController.commitCreate`, `commitUpdate`, and
`commitDelete` in `pubky-app/src/core/controllers/feed/feed.ts` delegate to
`FeedApplication` in `pubky-app/src/core/application/feed/feed.ts`. The
application writes feeds at `/pub/pubky.app/feeds/<hash-id>` and hydrates them
from that directory. The ID is derived from the serialized feed config, so
editing tags, reach, layout, sort, or content can change the path. Pubchi must
return a complete candidate feed and let this existing controller perform the
canonical normalization, hash, local persistence, and homeserver write.

App's architecture is explicitly
`UI/Coordinator -> Controller -> Application -> Service -> Model`
(`pubky-app/docs/architecture.md`). Controllers may update Zustand stores but
cannot perform IO; applications orchestrate services but cannot access stores;
services are the network boundary. Local-first naming and behavior are defined
in `pubky-app/docs/local-first.md`. Pubchi UI must call a Pubchi controller, not
Bot Kit, Scout, or the model provider directly.

App starts Ring authentication with
`HomeserverService.generateAuthUrl(caps)` in
`pubky-app/src/core/services/homeserver/homeserver.ts`. Its current default is
`/pub/pubky.app/:rw`, but the method already accepts custom `Capabilities`.
Pubchi must always pass explicit, narrower paths.

The main App auth store is single-identity and persists a WASM
`session.export()` in `pubky-app/src/core/stores/auth/auth.store.ts`. As
documented in `pubky-app/docs/adr/0020-session-bridge.md`, that export contains
public `SessionInfo`, not the HttpOnly cookie. It is not a portable bearer
credential and must not be mistaken for one. Pubchi needs a separate local bot
session handle; it must not replace or widen the signed-in human session.

Settings already have a single shared state and controller surface.
`SettingsController` in
`pubky-app/src/core/controllers/settings/settings.ts` updates the store and
delegates persistence to `SettingsApplication`, which writes
`/pub/pubky.app/settings.json`
(`pubky-app/src/core/application/settings/settings.ts`). Pubchi should propose
typed calls to this controller, not patch the settings document.

### Ring

Ring already supports more than one Pubky on a device. `createNewPubky()` and
`createPubkyWithInviteCode()` call
`generateMnemonicPhraseAndKeypair()` and save each identity independently
(`pubky-ring/src/utils/pubky.ts`). Multi-Pubky selection is handled by
`src/hooks/inputHandlerUtils.ts` and `src/hooks/useInputHandler.ts`.

Ring parses `pubkyauth://` requests containing path capabilities and presents
each path with read/write semantics in
`pubky-ring/src/components/ConfirmAuth.tsx`. `performAuth()` in
`pubky-ring/src/utils/pubky.ts` signs the auth request with the selected local
key. This is the mechanism Pubchi uses: the hosted session broker starts a
normal Pubky auth flow; Ring shows the requested paths; the user selects the
bot identity and authorizes it.

Ring can sign out a session when it possesses that session secret, but current
Ring `main` has no owner-facing list/revoke-all integration for sessions issued
to another client. That UI is a Stage 4 dependency, not existing functionality.

### Core and homeserver

Capabilities are path scopes plus `r` and/or `w` actions. A directory scope
ending in `/` covers descendants
(`pubky-core/pubky-common/src/capabilities.rs`). `w` currently covers
PUT/POST/DELETE together; there is no create-only capability. This matters:
compromise of an autonomous post session can delete bot posts within its path,
even when Pubchi's policy permits creation only.

Current `main` and the active local `feat/molt-drop` branch expose
`GET /session` and cookie-holder `DELETE /session` only
(`pubky-core/pubky-homeserver/src/client_server/routes/tenants/session.rs`).
`SessionInfo` has `created_at` but no expiry
(`pubky-core/pubky-common/src/session.rs`).

Owner-initiated revocation is **not merged**. It exists on the local and
BitcoinErrorLog remote branch `feat/session-revocation` at `e5f479fa`. That
branch adds:

- a default 30-day `expires_at`;
- `POST /sessions` using a fresh root AuthToken to list active session IDs,
  capabilities, creation, and expiry;
- `DELETE /sessions/<id>` to revoke one;
- `DELETE /sessions` to revoke all; and
- SDK methods `PubkySigner::list_sessions()`, `revoke_session(id)`, and
  `revoke_all_sessions()`.

The exact proposal is
`pubky-core/docs/SESSION_REVOCATION.md` on that branch. It is a hard gate for
any hosted Pubchi write session. Until it is merged, released, and surfaced in
Ring, Pubchi ships read-only with client-side assisted publication only.

The native Rust SDK can persist a bearer session without a key through
`PubkySession::export_secret()` / `import_secret()`
(`pubky-core/pubky-sdk/src/actors/session/persist.rs`). The JS/WASM binding does
not expose these secret APIs; its `export()` is metadata only
(`pubky-core/pubky-sdk/src/actors/session/core.rs`). Therefore the hosted
service needs a small native Rust session broker or a reviewed binding addition.
It cannot persist a Node `Session` by saving the browser-style export.

Private storage is not implemented. The only `/priv/` references in current
Core are examples explaining that writes outside `/pub/` are rejected and a
quota test that excludes `/priv/`. Stage 4 must not write any purported private
memory.

Signup tokens are homeserver account admission, not session authority. The
homeserver admin route is implemented under
`pubky-core/pubky-homeserver/src/admin_server/routes/generate_signup_token.rs`.
Each bot identity needs its own homeserver signup. The hosted Pubchi service
must never receive the signup token; Ring/App performs bot signup.

### Specs

`PubkyAppFeed` is implemented in
`pubky-app-specs/src/models/feed.rs` and lives at
`/pub/pubky.app/feeds/<hash-id>`. Its config is `tags`, `domain_tags`, `reach`,
`layout`, `sort`, and optional post `content` kind, plus top-level `name` and
`created_at`.

The optional bot profile `automation` block is implemented only on
`pubky-app-specs` branch `proposal/bot-automation-field` at `60ccc43`. It is not
version-bumped or released. The object lives inside
`/pub/pubky.app/profile.json` and requires `operator`, `capabilities`, `source`,
and `policy`
(`pubky-app-specs/docs/proposals/bot-automation-field.md`). The capability
strings are declarations, not ACLs.

The proposed `automation.operator` is a claim made by the bot. By itself it
does not prove that the named person accepted ownership. Pubchi adds a
reciprocal owner-signed binding under the owner's namespace and renders an
operator as verified only when both objects agree.

### Nexus and Scout

Nexus does not index arbitrary `/pub/<app>/` data. The specs URI parser rejects
an app segment other than `pubky.app`
(`pubky-app-specs/src/uri/parsed.rs`). Inside `pubky.app`, `Resource` recognizes
feeds, but the Nexus watcher has no `Feed` branch in
`pubky-nexus/nexus-watcher/src/events/mod.rs`; unhandled objects fall through
to a debug log. Consequently:

- `/pub/pubchi.app/**` is not indexed;
- `PubkyAppFeed` objects are not currently projected into Nexus; and
- Pubchi must read its config/memory directly from public homeserver storage.

Nexus does index canonical profiles, posts, follows, tags, bookmarks, and files,
which is enough for launch graph reads and bot-authored post/tag visibility.

Bot Kit's Scout layer supplies typed, parameterized tools and evidence metadata
in `pubky-ai-bot-jeb/packages/bot-kit/src/scout/`. The NLQ service in
`packages/bot-kit/src/nlq/service.ts` plans only allowlisted tools, checks the
live Scout schema, applies per-caller and global budgets, and returns sources
and tool traces. Its documented `asker` is currently an unauthenticated hint
(`pubky-ai-bot-jeb/docs/nlq.md`); Pubchi must override it from the enrolled
tenant binding rather than trusting a request body.

### Jeb and Bot Kit

Bot Kit extraction is complete according to
`pubky-ai-bot-jeb/docs/bot-kit-extraction.md`. Reusable modules include ingest,
context, Nexus REST, Scout, NLQ, policy, switches, security, answer loop,
knowledge retrieval, web search, publish gateway, and tags.

The concrete launch boundaries are:

- fail-closed blacklist, rate, and token policy:
  `packages/bot-kit/src/policy/policy.ts`;
- named switches:
  `packages/bot-kit/src/policy/switches.ts`;
- key-free reason/ingest environment allowlists:
  `packages/bot-kit/src/security/keys.ts`;
- bounded model/tool loop:
  `packages/bot-kit/src/answer/tool-loop.ts`;
- typed NLQ:
  `packages/bot-kit/src/nlq/`;
- typed Scout:
  `packages/bot-kit/src/scout/`;
- idempotent, switch-gated publisher:
  `packages/bot-kit/src/publish/publisher.ts`; and
- self/artifact tag write gates:
  `packages/bot-kit/src/tags/apply.ts`.

Jeb's `SessionTransport` in
`packages/bot-kit/src/publish/homeserver.ts` signs in from a bot key. Pubchi
must implement a different transport backed by the session broker. Importing
Jeb's key loader into Pubchi is forbidden.

Bot Kit's existing `suggestTags()` is deterministic categorization of Jeb
intents/products; it is not the general semantic Tagky described by the vision.
The apply/vocabulary/approval boundary is reusable. Semantic tag generation is
new work and must be evaluated separately.

### Locks and Paykit

`pubky-locks/readme.md` is a draft specification and implementation plan, not a
shipped service. It explicitly defers confidential delivery and proposes
`/priv/` paths that Core does not yet support. Locks is not a Stage 4 launch
dependency.

Paykit's narrow public directory API is real:
`paykit-rs/paykit-lib/README.md` documents authenticated publication and public
discovery under `/pub/paykit.app/v0/`. That same README explicitly says the
crate does **not** implement receipts, Locks, or Atomicity credit flows. Paid
Pubchi tiers must therefore remain outside Stage 4 launch.

## 3. **Identity & keys**

Let `U` be the user's human Pubky and `B` the Pubchi Pubky.

### Enrollment

1. In Ring, the user selects **Add Pubky** and creates `B` using the existing
   `generateMnemonicPhraseAndKeypair()` path. Ring stores and backs up `B`
   independently from `U`.
2. Ring/App signs `B` up to the user's chosen homeserver using a signup token.
   The token and mnemonic never enter Pubchi host logs or requests.
3. Using a local session for `B`, App writes:
   `pubky://B/pub/pubky.app/profile.json` with
   `automation.operator = U`, declared capability tokens, source URL, and
   policy URL.
4. Using the existing local human session, App writes the reciprocal binding:
   `pubky://U/pub/pubchi.app/bots/B.json`.
5. App reads both objects back. The bot profile is “verified as operated by U”
   only when the two directions match and neither object is expired/revoked.

The reciprocal binding is:

```json
{
  "schema": "pubchi-owner-binding",
  "version": 1,
  "owner": "<U>",
  "bot": "<B>",
  "status": "active",
  "created_at": 1788600000,
  "updated_at": 1788600000
}
```

Because this object is stored in `U`'s namespace through `U`'s session, a bot
cannot forge the reciprocal declaration. Deleting it or changing `status` to
`revoked` immediately removes the verified owner association in compatible
clients even if a lost bot session is still alive.

### Hosted session issuance

The hosted session broker in the Pubchi repository starts a native
`PubkyAuthFlow` with exact capabilities and returns its `pubkyauth://` URL to
App. App opens that URL in Ring. Ring displays the requested paths; the user
selects `B`, not `U`, and approves. The encrypted HTTP relay carries an
AuthToken to the broker; the relay cannot decrypt it
(`pubky-core/pubky-sdk/src/actors/auth_flow.rs`). The broker exchanges the token
for a homeserver session.

The broker immediately verifies:

- `session.info.public_key == B`;
- every granted capability is in the exact requested set;
- reciprocal binding `U -> B` is active;
- no root (`/:rw`) or human `U` session was returned.

It then stores `PubkySession::export_secret()` encrypted at rest and drops the
AuthToken. The secret is a bearer credential and is visible only to the broker.
The TypeScript reason, NLQ, gateway, and scheduler processes receive `B`, `U`,
budgets, and policy—not the session secret.

At publish time a per-tenant publisher sends a typed request over a
filesystem-permissioned Unix socket to the broker. The broker imports and
revalidates the session, checks the requested path against the stored grant,
performs the homeserver request, and read-backs the object. On 401/404
revalidation failure it marks the grant `reauthorization_required`; it never
signs in with a key.

### Revocation

Revocation has two layers:

1. **Immediate service stop:** App sets the tenant and publisher switches off.
   This stops the honest Synonym deployment but is not sufficient after host
   compromise.
2. **Protocol revocation:** Ring signs a fresh root AuthToken for `B`, calls
   `POST /sessions`, shows session ID, capabilities, creation, and expiry, then
   calls `DELETE /sessions/<id>` or `DELETE /sessions`.

Layer 2 depends on `pubky-core` `feat/session-revocation`. No hosted write
session is issued before that API is released and Ring can exercise it.

### Device loss

- If the user backed up `B`'s mnemonic, they restore `B` in Ring, revoke all
  sessions, and issue new ones.
- If `B` is unavailable but `U` remains available, the user revokes the
  reciprocal owner binding. Compatible clients stop presenting the bot as
  theirs, but this does **not** revoke `B`'s homeserver session.
- If both keys are lost, there is no cryptographic recovery. Existing sessions
  remain valid until expiry. The Stage 4 session-expiry branch bounds this to
  the configured TTL (30 days by default); without that branch the current
  one-year-style bearer exposure is unacceptable.

The UI must state this during setup and require a confirmed `B` backup before
autonomous mode.

## 4. **Permission tiers**

The tier is stored in `preferences.json`, but effective authority is the
intersection of that preference, active Ring-issued sessions, tenant switches,
format policy, and budgets. A string saying `"autonomous"` never grants access.

### Read-only

- **Host session:** none.
- **Reads:** public Nexus, Scout, and public homeserver objects.
- **Writes:** App may update `B`'s public config using its local bot session;
  the host cannot write.
- **UI:** chat, summaries, feed previews, graph insights, settings proposals,
  “Apply” and “Dismiss”.
- **Failure guarded:** a compromised host has no homeserver bearer and cannot
  publish or alter bot memory.

Requests are bound to the enrolled pair by an App-written one-time request at
`pubky://B/pub/pubchi.app/requests/<request-id>.json`, containing the SHA-256 of
the request body and a 10-minute expiry. The service fetches that object from
the homeserver, verifies `bot = B`, `owner = U`, hash, expiry, and reciprocal
binding, and consumes the ID once in its database. Public storage means this is
authorization against spoofing and budget theft, not confidentiality.

### Assisted

- **Host session:** none for synchronous use. If the user separately enables
  hosted background suggestions, one bot session exactly
  `/pub/pubchi.app/suggestions/:w,/pub/pubchi.app/runs/:w`.
- **Host writes:** none for synchronous use. The optional background service
  writes public suggestion and metadata-only run-receipt objects under `B`.
- **User-authored writes:** App displays a diff and, after explicit approval,
  invokes existing local controllers with `U`'s local session.
- **UI:** queue with source evidence, requested action, before/after,
  expiration, Approve, Edit, Reject.
- **Failure guarded:** unapproved drafts stay in App's local IndexedDB rather
  than becoming public homeserver objects. The host cannot write any canonical
  post, tag, feed, or human settings path. A fabricated public suggestion is
  not sufficient; the App's local approval event triggers the user write.

An assisted post under `U` is created by
`PostController.commitCreate()` client-side. A feed uses
`FeedController.commitCreate/commitUpdate()`. A settings change calls the
specific `SettingsController` method. A user tag uses the existing tag
controller. The bot host never receives those sessions.

### Autonomous

Autonomous means Pubchi may publish **as `B`** under user-defined policy. It
never means publishing as `U` on a server.

Use one bot key with separate revocable sessions:

- state session:
  `/pub/pubchi.app/cursors/:rw,`
  `/pub/pubchi.app/follower-snapshots/:rw,`
  `/pub/pubchi.app/suggestions/:w,`
  `/pub/pubchi.app/runs/:w`;
- post publisher:
  `/pub/pubky.app/posts/:w`;
- tag publisher:
  `/pub/pubky.app/tags/:w`.

The sessions are split so revoking auto-tagging does not disable summaries or
posts. Bot profile, owner binding, preferences, provider selection, and
approved format policy remain client-controlled and are not in host write
scopes.

The publisher accepts only:

```text
PublishRequestV1 {
  tenant_bot, action_id, object_kind, path, canonical_json_sha256,
  policy_version, evidence_id, idempotency_key, expires_at
}
```

It rejects paths outside the session's fixed prefix, unknown object kinds,
expired requests, mismatched tenant IDs, non-canonical spec objects, missing
evidence, and formats not approved in `formats.json`. It rechecks global,
tenant, capability, and format switches immediately before PUT.

Current Core `w` also permits DELETE. Policy can refuse delete requests, but a
stolen session can still delete within its scoped path. The blast radius is
limited to `B`, never `U`; create-only capabilities are a recommended Core
follow-up before autonomy expands beyond a beta.

### Moving between tiers

- Moving down is immediate: App turns off switches, revokes now-unneeded
  sessions in Ring, and updates preferences only after revocation succeeds.
- Moving up is two-step: App updates the desired tier, then Ring grants each
  new session separately. The tier becomes effective only after broker
  read-back proves the exact capabilities.
- A failed or abandoned Ring flow leaves the old lower tier active.
- Reauthorization never silently widens an existing session. A scope change
  creates a new session, verifies it, then revokes the old one.

## 5. **Memory & configuration**

### Ownership and paths

All Stage 4 memory is public and stored under the bot identity `B`:

```text
/pub/pubchi.app/manifest.json
/pub/pubchi.app/preferences.json
/pub/pubchi.app/interests.json
/pub/pubchi.app/formats.json
/pub/pubchi.app/provider.json
/pub/pubchi.app/feeds/<feed-id>.json
/pub/pubchi.app/follower-snapshots/<unix-seconds>.json
/pub/pubchi.app/cursors/what-i-missed.json
/pub/pubchi.app/requests/<request-id>.json
/pub/pubchi.app/suggestions/<suggestion-id>.json
/pub/pubchi.app/runs/<run-id>.json
```

Nexus does not index these paths. App and Pubchi read them directly from the
homeserver. Every object has a closed schema; unknown fields are rejected until
a newer version is explicitly supported.

### Common envelope

Every object except the embedded `PubkyAppFeed` payload includes:

```json
{
  "schema": "pubchi-preferences",
  "version": 1,
  "bot": "<B>",
  "owner": "<U>",
  "updated_at": 1788600000
}
```

`schema` selects the validator; `version` selects migration logic; `bot` and
`owner` prevent cross-tenant import; `updated_at` supports conflict display but
is not trusted as authorization.

### Preferences

`/pub/pubchi.app/preferences.json`:

```json
{
  "schema": "pubchi-preferences",
  "version": 1,
  "bot": "<B>",
  "owner": "<U>",
  "updated_at": 1788600000,
  "display_name": "Pubchi",
  "tier": "read-only",
  "language": "en",
  "summary": {
    "length": "short",
    "include_sources": true,
    "include_disagreement": true
  },
  "proactive": {
    "enabled": false,
    "max_suggestions_per_day": 1,
    "quiet_hours_utc": { "start": 22, "end": 7 }
  }
}
```

Allowed tier values are `read-only`, `assisted`, and `autonomous`; the stored
value remains non-authoritative.

### Feed definitions

`/pub/pubchi.app/feeds/<feed-id>.json` wraps an exact spec-compatible
`PubkyAppFeed`:

```json
{
  "schema": "pubchi-feed-definition",
  "version": 1,
  "bot": "<B>",
  "owner": "<U>",
  "updated_at": 1788600000,
  "feed": {
    "feed": {
      "tags": ["bitcoin", "scaling"],
      "domain_tags": ["builder"],
      "reach": "wot",
      "layout": "wide",
      "sort": "recent",
      "content": "short"
    },
    "name": "Bitcoin scaling nearby",
    "created_at": 1788600000
  },
  "installed_user_feed_id": null
}
```

The service never invents a homeserver feed ID. App validates the embedded
object with the installed `pubky-app-specs` version and calls
`FeedController.commitCreate()`. It then records the returned hash-derived ID
in a new wrapper revision. Unsupported reaches—such as combinations the App
mapper rejects—fail before display.

### Topic interests

`/pub/pubchi.app/interests.json`:

```json
{
  "schema": "pubchi-interests",
  "version": 1,
  "bot": "<B>",
  "owner": "<U>",
  "updated_at": 1788600000,
  "topics": [
    {
      "label": "bitcoin",
      "weight": 3,
      "source": "explicit",
      "expires_at": null
    }
  ],
  "excluded_topics": ["politics"]
}
```

Only explicit user choices are persisted at launch. Behavioral inference may
be shown as a suggestion but is not silently converted into memory.

### Approved formats

`/pub/pubchi.app/formats.json`:

```json
{
  "schema": "pubchi-approved-formats",
  "version": 1,
  "bot": "<B>",
  "owner": "<U>",
  "updated_at": 1788600000,
  "formats": [
    {
      "id": "weekly-missed-summary",
      "mode": "suggest-only",
      "enabled": true,
      "max_per_day": 1,
      "allowed_outputs": ["draft"],
      "policy_version": 1
    }
  ]
}
```

Launch values for `mode` are `suggest-only` and `assisted`. An autonomous value
is accepted only after that format's separate graduation proof. Unknown format
IDs fail closed.

### Provider choice

`/pub/pubchi.app/provider.json`:

```json
{
  "schema": "pubchi-provider",
  "version": 1,
  "bot": "<B>",
  "owner": "<U>",
  "updated_at": 1788600000,
  "execution": "synonym-hosted",
  "provider": "default",
  "model": null,
  "send_public_graph_context": true,
  "send_public_web_context": false
}
```

No API key, token, credential reference, private endpoint, or secret-store path
is legal. At launch, provider choice means an approved Synonym-hosted provider
using Synonym credentials, or `execution = self-hosted`. BYOK on the shared
host waits for a private credential mechanism. Self-hosters put provider
credentials in their own deployment secret store, outside Pubchi memory.

### Follower snapshots

`/pub/pubchi.app/follower-snapshots/<unix-seconds>.json`:

```json
{
  "schema": "pubchi-follower-snapshot",
  "version": 1,
  "bot": "<B>",
  "owner": "<U>",
  "updated_at": 1788600000,
  "observed_at": 1788600000,
  "source": "nexus",
  "followers": ["<pubky-a>", "<pubky-b>"],
  "complete": true,
  "next_cursor": null
}
```

The list is sorted and deduplicated. `complete = false` forbids unfollow or
growth conclusions. Snapshot data is already derivable from public Nexus, but
its historical aggregation can still feel sensitive; the UI calls it public
and lets the user disable/delete it.

### “What I missed” cursor

`/pub/pubchi.app/cursors/what-i-missed.json`:

```json
{
  "schema": "pubchi-what-i-missed-cursor",
  "version": 1,
  "bot": "<B>",
  "owner": "<U>",
  "updated_at": 1788600000,
  "last_completed_until": 1788590000,
  "last_run_id": "run-01",
  "sources": {
    "notifications_end": 1788590000,
    "feed_windows": {
      "<feed-id>": 1788590000
    }
  }
}
```

The cursor advances only after a complete result is displayed or stored. A
timeout, truncated unknown result, or partial page leaves the prior cursor so a
retry may duplicate evidence but cannot silently skip it.

### Request binding

`/pub/pubchi.app/requests/<request-id>.json` proves that the locally held bot
session authorized one API request without publishing the prompt:

```json
{
  "schema": "pubchi-request",
  "version": 1,
  "bot": "<B>",
  "owner": "<U>",
  "updated_at": 1788600000,
  "request_id": "req-01",
  "body_sha256": "<64-lowercase-hex>",
  "capability": "build-feed",
  "expires_at": 1788600600
}
```

The schema admits no body, URL, header, nonce secret, session material, or
free-form metadata. The service consumes `(B, request_id)` once. Deleting the
public object later is housekeeping, not the replay defense.

### Background suggestions

`/pub/pubchi.app/suggestions/<suggestion-id>.json` is written only when the user
has opted into public hosted background suggestions:

```json
{
  "schema": "pubchi-suggestion",
  "version": 1,
  "bot": "<B>",
  "owner": "<U>",
  "updated_at": 1788600000,
  "suggestion_id": "suggestion-01",
  "kind": "what-i-missed",
  "title": "Three threads worth revisiting",
  "summary": "A short summary derived only from the cited public objects.",
  "source_uris": [
    "pubky://<author>/pub/pubky.app/posts/<post-id>"
  ],
  "run_id": "run-01",
  "expires_at": 1789204800
}
```

Allowed kinds and text lengths are closed. Source URIs must be public
`pubky.app` resources. No user prompt, rejected draft, private input, or raw
tool output is stored. App treats the object as untrusted public bot output and
never converts it to a user action without a local approval.

### Run receipts

`/pub/pubchi.app/runs/<run-id>.json` records accountability without retaining
conversation content:

```json
{
  "schema": "pubchi-run-receipt",
  "version": 1,
  "bot": "<B>",
  "owner": "<U>",
  "updated_at": 1788600000,
  "run_id": "run-01",
  "capability": "what-i-missed",
  "request_sha256": "<64-lowercase-hex>",
  "policy_version": 1,
  "provider": "default",
  "status": "complete",
  "source_uris": [
    "pubky://<author>/pub/pubky.app/posts/<post-id>"
  ],
  "model_input_tokens": 1200,
  "model_output_tokens": 220,
  "started_at": 1788599990,
  "finished_at": 1788600000,
  "output_sha256": "<64-lowercase-hex>"
}
```

Allowed statuses are `complete`, `refused`, `budget-exhausted`, and `failed`.
Errors are fixed codes, not stack traces. The receipt has hashes and public
source URIs, not prompt text, answer text, tool payloads, IPs, or internal
deployment data.

### Manifest

`/pub/pubchi.app/manifest.json` is itself versioned:

```json
{
  "schema": "pubchi-manifest",
  "version": 1,
  "bot": "<B>",
  "owner": "<U>",
  "updated_at": 1788600000,
  "objects": [
    {
      "path": "/pub/pubchi.app/preferences.json",
      "schema": "pubchi-preferences",
      "version": 1,
      "bytes": 420,
      "sha256": "<64-lowercase-hex>"
    }
  ]
}
```

Paths must be members of the Stage 4 allowlist and cannot contain `..`, encoded
slashes, query strings, or foreign pubkys.

### Export and import

`manifest.json` lists every portable path, schema/version, byte length, and
SHA-256. App export:

1. lists only the allowlisted paths above;
2. validates every object;
3. writes a deterministic JSON bundle containing objects and hashes; and
4. excludes requests, suggestions, and run receipts by default unless the user
   explicitly includes public history.

Import requires the destination session to be for the same `B`, verifies all
hashes and the active reciprocal binding, migrates each known version in
memory, presents a diff, and writes only after confirmation. A homeserver move
uses the same bot key; import does not mint a replacement identity. A bundle
for another bot/owner pair is rejected.

Proof is an export from Homeserver A, import to Homeserver B after PKARR
migration, byte/hash comparison, and successful App feed reconstruction.

### Later private storage

When Core ships an audited private namespace, these new categories may move
behind it:

- conversation history the user explicitly elects to retain;
- rejected drafts and feedback currently kept only in App's local database;
- fine-grained behavior-derived preferences;
- detailed historical follower snapshots;
- private source selections; and
- provider credentials, only if the encryption and access model supports them.

Public objects keep stable IDs or public pointers to private replacements so
older clients fail with “private memory unavailable,” not accidental exposure.
Migration copies, verifies, deletes the public source, then verifies public GET
returns 404. It never merely hides a link.

### Forbidden memory

Stage 4 schemas reject:

- root keys, bot keys, mnemonics, recovery files, session cookies, AuthTokens,
  signup tokens, API keys, passwords, OAuth tokens, or credential references;
- direct messages, unlisted/private posts, private files, or clipboard content;
- payment receipts, invoices, preimages, wallet addresses linked to identity,
  balances, or financial notes;
- health, legal, employment, exact location, or intimate personal notes;
- full browsing history, keystrokes, raw analytics, device identifiers, IP
  addresses, or contact books;
- system prompts, deployment topology, database URLs, or internal logs; and
- arbitrary user-defined JSON fields or free-form “remember this” text.

A user asking Pubchi to remember forbidden data gets a deterministic refusal
and no write request.

## 6. **Brain**

### Default inference path

The Synonym-hosted default is a per-tenant adaptation of Bot Kit's answer loop:

```text
App request
  -> verified request object + reciprocal binding
  -> tenant policy and budget
  -> intent/NLQ plan
  -> typed Nexus/Scout/knowledge tools
  -> untrusted-result screen
  -> model composition
  -> typed proposal
  -> App display or isolated publisher
```

`createToolLoop()` in
`pubky-ai-bot-jeb/packages/bot-kit/src/answer/tool-loop.ts` supplies per-step
timeouts, a total answer budget, bounded tool steps, screening, evidence
composition, and deterministic fallback. Pubchi injects its own identity,
prompt, formats, and tools; it does not fork this loop.

The default follows
`pubky-ai-bot-jeb/docs/adr/0002-llm-hosting-and-cost.md`: Synonym-hosted
OpenAI-compatible inference now, user-selectable provider as required exit,
local/QVAC after the same evaluation gates pass. The ADR's suggestion to put a
provider key in homeserver config is overridden by the public-memory rule:
provider secrets cannot be stored there before private storage.

### Tenant context

Every run constructs an immutable `TenantContext`:

```text
{ bot B, owner U, binding hash, tier, policy version, provider selection,
  budget key, allowed tools, allowed output kinds, request id }
```

The gateway derives `U` from the verified reciprocal binding. It discards a
caller-supplied NLQ `asker`, then calls Bot Kit NLQ with `asker = U`. This closes
the current NLQ hint weakness and ensures `trust_view`, `follow_path`, and
`profile_card` use the enrolled owner's graph context.

Tool output remains evidence, not truth. Tags are claimant-attributed claims;
global and owner-graph counts are shown separately; no result silently becomes
a reputation verdict. This follows the provenance and disagreement rules in
`Synonym/articles/pubky/nexus-scout-agentic-web.md` and
`Synonym/articles/pubky/social-intelligence-is-not-artificial.md`.

### NLQ and Scout

Pubchi uses the existing schema-aware planner and typed tools in
`packages/bot-kit/src/nlq/` and `packages/bot-kit/src/scout/`. Raw Cypher stays
off in the public service. The useful launch tools include:

- `search_posts`, `scout_get_thread`, `get_topic_brief`;
- `get_what_changed`, `get_related_posts`, `get_debate_map`;
- `follow_path`, `trust_view`, `top_posts`, `mentions_of`;
- `profile_card`, `get_identity_summary`, and `get_tag_landscape`.

Scout cannot provide likes because Nexus has no like relationship. “Top” is
always labeled by bookmarks, replies, or reposts. A schema fetch failure,
breaker, budget exhaustion, or unsupported relationship returns an explicit
unavailable result and no invented answer.

### Knowledge separation

Jeb's public product knowledge corpus may be mounted read-only as a shared
`KnowledgeStore`. It contains canonical/released/proposal metadata and public
source citations
(`packages/bot-kit/src/knowledge/store.ts`). Pubchi tenant data is never
inserted into those tables.

Per-user knowledge at launch is limited to the validated public objects under
`/pub/pubchi.app/` and public graph context fetched for the current run. It is
loaded into a tenant-scoped ephemeral context and discarded after the run
except for the explicit run receipt. There is no shared embedding index of
users' memory. If per-user embeddings are added later, they require a
tenant-specific collection/key, deletion proof, and Kimi privacy audit.

### Budgets

Each run is checked before model/tool use against:

- per-request model tokens and wall clock;
- per-owner hourly and UTC-day model tokens;
- per-tenant Scout query count and rows;
- per-tenant web calls;
- global deployment ceilings; and
- proactive suggestions per day.

Checks fail closed if the budget store is unavailable. Budget failures produce
a typed notice, not a partial setting change or publish request. Cost is
attributed to `B`, `U`, provider, capability, and run ID without logging prompt
text.

### Provider exit and local path

Hosted provider selection is policy-controlled and sends only public context.
The UI states the provider and whether public feed/web content leaves Synonym
before the first call.

Self-hosting runs the same Pubchi service and Bot Kit contract with
`execution = self-hosted`; the user supplies provider secrets to their own
secret manager. A local/QVAC path is “later” until it passes:

- the same material-claim and no-invention evaluation;
- typed tool-call compatibility;
- prompt-injection and secret-extraction suites; and
- the configured answer latency/budget on representative user hardware.

Model replacement must not change `B`, memory objects, owner binding, feeds,
or Pubky reputation.

## 7. **Capabilities at launch**

Every capability returns a typed result with `run_id`, sources, truncation,
tool trace, policy version, and `generated_at`. Chat prose is a rendering of
that result, not the contract.

### Feed summaries

- **Inputs:** owner `U`, a canonical `PubkyAppFeed` or current App stream ID,
  explicit time range, summary preferences.
- **Tools:** App resolves the feed to current stream parameters; Pubchi uses
  Nexus post streams/REST and Scout `get_topic_brief`, `top_posts`, and
  `get_debate_map` as applicable.
- **Output:** chat result plus
  `/pub/pubchi.app/runs/<run-id>.json` only when the active tier has a run-write
  session. It does not publish a post.
- **Tier:** read-only.
- **Test:** fixed feed fixture with known authors/tags; assert cited URIs,
  explicit metric labels, minority/disagreement inclusion, truncation notice,
  and zero homeserver PUT from the host in read-only mode.

### “What did I miss?”

- **Inputs:** last completed cursor, now, selected feeds, notification range.
- **Tools:** Nexus notification/feed reads, `get_what_changed`, `mentions_of`,
  `top_posts`, and thread hydration.
- **Output:** sections by source with cited objects; a proposed next cursor.
  App writes the cursor in read-only/assisted mode; the autonomous state
  publisher may write it only after complete output.
- **Tier:** read-only for on-demand use; assisted state session for background
  persistence.
- **Test:** events on both sides of the cursor, duplicate boundary timestamp,
  partial Nexus page, deleted post, Scout timeout. Assert no event is skipped
  and cursor does not advance on partial failure.

### Natural language to `PubkyAppFeed`

- **Inputs:** utterance, existing feed when editing, App-supported enum/version.
- **Tools:** NLQ intent parsing and schema; no raw Cypher is required to build
  the object.
- **Output:** full candidate `PubkyAppFeed`, human-readable diff, and warnings
  for unsupported semantics. App calls existing `FeedController` only after
  approval.
- **Tier:** read-only to preview; assisted to apply as `U`.
- **Test:** golden utterances for tags, domain tags, reach, sort, layout, and
  content; round-trip through installed specs and App normalizer; negative
  prompts asking for nonexistent likes or unsupported reach must be rejected,
  not approximated silently.

### Tag suggestions (Tagky)

- **Inputs:** target public URI/content, owner interest config, graph tag
  evidence.
- **Tools:** a new `suggest_semantic_tags` capability with a closed output
  schema; `get_tag_landscape`; Bot Kit tag label validator and
  `applyTags()` gate.
- **Output:** labels with rationale/evidence. No tag object is written by
  suggestion.
- **Tier:** read-only to suggest; assisted for a user-authored tag; autonomous
  only for a bot-authored tag from the separate tag session and an approved
  format.
- **Test:** semantic positive set, prohibited/invalid labels, prompt injection
  in target content, duplicate labels, user rejection, and attribution check
  that autonomous tag URI belongs to `B`.

### Graph insights

- **Inputs:** enrolled owner `U`, time range, requested subject/topic.
- **Tools:** `trust_view`, `follow_path`, `mentions_of`, `profile_card`,
  `get_identity_summary`, `get_tag_landscape`.
- **Output:** evidence map separating global claims from claims within `U`'s
  graph. Never a universal trust score.
- **Tier:** read-only.
- **Test:** contradictory self/third-party claims, empty new-user graph,
  same-name identities, fake caller-supplied `asker`, and MUTED data. Assert
  `asker` is `U`, identities remain pubkys, and muted counterparties are never
  enumerated.

### Settings by conversation

- **Inputs:** utterance and an allowlisted snapshot of current App settings.
- **Tools:** deterministic intent/slot parser plus model only when needed.
- **Output:** `SettingCommandV1 { setting, old_value, new_value }`; never JSON
  Patch and never an arbitrary path.
- **Tier:** read-only to preview; assisted to apply.
- **Apply:** UI dispatches the corresponding
  `SettingsController.setNotificationPreference`, privacy setter, or other
  existing typed method. Unsupported settings are answered as unsupported.
- **Test:** every allowlisted command maps to exactly one controller call;
  unknown key, stale old value, and multi-setting ambiguity require review;
  model output cannot name a homeserver URL.

### Proactive suggestions

- **Inputs:** explicit interests, feed definitions, public snapshots/cursors,
  frequency and quiet hours.
- **Tools:** the read-only capabilities above.
- **Output:** suggestion/draft only by default. Synchronous drafts stay local
  to App; background suggestions are explicitly public. No user setting, feed,
  post, or tag changes automatically.
- **Tier:** on-demand read-only while App is open; assisted state session for a
  hosted background queue; autonomous publication only after a specific format
  graduates.
- **Test:** frequency cap, quiet hours, duplicate idempotency, global/tenant
  proactive switch, stale config, revoked session, and intentionally malicious
  feed content. Assert no canonical write exists unless the format and
  publisher sessions are both active.

## 8. **Pubky App work**

All work is behind `PUBKY_RUNTIME_PUBCHI_ENABLED` and removable without
changing normal auth, feed, collection, post, or settings paths.

### UI surfaces

- **Chat panel:** a lazy-loaded route/panel that renders typed run results,
  citations, tool-unavailable states, and proposal cards. It does not call
  model or Scout APIs directly.
- **Settings panel:** name, public-memory notice, provider/execution choice,
  interests, proactive frequency, export/import, and desired tier.
- **Bot profile:** persistent Bot badge, operator claim, reciprocal-binding
  verification, declared capabilities, policy, source, and revoke control.
- **Approval queue:** before/after diff, sources, expiry, edit, reject, approve,
  and attribution (“Publish as you” versus “Publish as Pubchi”).
- **Permission UI:** displays desired versus effective tier and each exact Ring
  capability. Every grant or widening opens Ring.

### Core layering

Add these domains in `pubky-app`:

```text
src/core/controllers/pubchi/
src/core/application/pubchi/
src/core/services/pubchi/
src/core/services/local/pubchi/
src/core/models/pubchi/
src/core/pipes/pubchi/
src/core/stores/pubchi/
```

Responsibilities:

- `PubchiController`: UI entry point; reads auth/pubchi stores; normalizes
  request; calls application; updates local UI state.
- `PubchiApplication`: orchestrates request-object write, Pubchi API call,
  response validation, and local persistence. It returns typed proposals.
- `PubchiService`: HTTP only, pinned base URL, timeout, response-size limit,
  no redirects, typed errors.
- `LocalPubchiService`/model: IndexedDB cache for chat and approval queue.
- Pubchi pipes: strict schemas and conversions to installed
  `pubky-app-specs`.

`PubchiApplication` does not call `FeedApplication`,
`SettingsApplication`, or controllers. The approval hook/UI invokes the
existing public controllers as a new user action after the Pubchi proposal is
accepted. This preserves the architecture's direction and avoids adding a new
cross-application exception.

The second bot session is isolated from `useAuthStore`. A dedicated
`PubchiBotSessionService` owns it and verifies `session.info.publicKey == B`
before every bot-memory request. Browser persistence follows the SDK's
HttpOnly-cookie model and stores metadata only; losing that cookie requires a
Ring reauthorization, never a key import into App.

### Feature separation

- With the flag off, no Pubchi route, coordinator, polling, service call, or
  bundle is active.
- Existing `FeedController`, `SettingsController`, and post/tag controllers
  keep their signatures.
- The only specs-dependent profile change is additive rendering of
  `automation`.
- VRT must mount the production chat, profile badge, permission panel, and
  approval cards, with fixtures but no hand-drawn substitute surfaces.
- E2E covers flag off, read-only, assisted approval, grant denial, revocation,
  provider outage, and stale proposal.

## 9. **Hosting & multi-tenancy**

### Deployment units

One Pubchi deployment serves many bot identities through five trust domains:

1. **Gateway/API:** validates request-object binding, tenant, schemas, and
   response limits. No session or provider key.
2. **Reason/NLQ workers:** provider credential, public context, and tenant
   policy. No Pubky session.
3. **Scheduler:** reads due tenants and public config. No publish session.
4. **Publisher workers:** one tenant at a time; validate Bot Kit
   `PublishRequestV1`; no model credential.
5. **Rust session broker:** encrypted bearer sessions and homeserver transport;
   no model, Scout, web, prompt, or arbitrary SQL.

The first four live in `pubky-ai-bot-pubchi` and import
`@pubky/bot-kit`. The broker is a Rust package in the same repository and uses
the released `pubky-sdk` native `export_secret/import_secret` API.

### Tenant storage

Every table has `tenant_bot` as part of its primary/unique keys:

```text
tenants(tenant_bot, owner, binding_hash, desired_tier, effective_tier, status)
tenant_switches(tenant_bot, switch_name, on)
tenant_budgets(tenant_bot, utc_day, model_tokens, scout_calls, web_calls)
tenant_requests(tenant_bot, request_id, body_hash, expires_at, consumed_at)
tenant_runs(tenant_bot, run_id, capability, outcome, evidence_id, cost)
publish_requests(tenant_bot, idempotency_key, path, json_hash, status)
session_grants(tenant_bot, grant_kind, ciphertext, nonce, capabilities_hash,
               created_at, expires_at, status)
```

PostgreSQL row-level security requires `app.tenant_bot` on tenant-facing
connections. The gateway starts a transaction, sets the tenant, and cannot
query without it. Global operator reporting uses a separate read-only role.
Reason jobs carry one serialized `TenantContext`; workers clear all context
after each job and keep no module-level “current user”.

The broker encrypts native session exports with an AEAD key held only by the
broker. Production uses a managed KMS/envelope key; staging may use a
deployment secret with rotation proof. The ciphertext database is useless
without that key. Logs contain tenant bot IDs and rule/outcome codes, never
session exports, prompts, memory bodies, or provider credentials.

### Publisher isolation

Each claimed publish row is leased to a publisher for exactly one
`tenant_bot`. The publisher cannot request another tenant's session socket.
The broker socket namespace and process credentials are tenant-scoped; the
broker independently compares tenant, capability hash, and path.

Idempotency is `(tenant_bot, idempotency_key)`. A successful PUT is read back
and hashed before the row becomes published. Crash-after-PUT retries the same
path and hash. A hash mismatch stops that tenant publisher and raises an
operator alert; it never overwrites unknown content.

The global switch stops all writes; tenant switches stop one Pubchi; capability
switches stop state, posts, tags, or proactive work independently. Switch
lookups fail closed.

### Cross-user leakage controls

- no shared prompt arrays, chat histories, embedding collections, or mutable
  tenant singleton;
- RLS plus tenant-keyed uniqueness;
- one tenant per reason job and publisher lease;
- provider cache keys include tenant and policy version, and response caching
  is off for personalized prompts by default;
- evidence rows reference public URIs and tenant IDs but do not copy entire
  documents; and
- a two-tenant poison test plants unique canary strings in each config and
  asserts neither appears in the other's prompt, tool trace, output, cache,
  log, or publish body.

### Self-hosted Pubchi

The same repository supports a single-tenant profile:

- `PUBCHI_BOT=<B>` and `PUBCHI_OWNER=<U>`;
- one local PostgreSQL database;
- public Scout or user-selected Scout URL;
- provider secret in the operator's secret store;
- local Rust session broker; and
- no multi-tenant scheduler or RLS bypass role.

Self-hosting does not require a Synonym registration. The reciprocal binding
and public profile identify the operator and policy. Contract tests run against
both hosted and single-tenant profiles.

## 10. **Security & privacy model**

### Bot host compromise

- **Risk:** attacker reads memory, drafts, provider context, or bearer sessions
  and posts/deletes as `B`.
- **Mitigation:** no keys; separate broker; encrypted sessions; narrow split
  capabilities; 30-day maximum by default; owner revocation; reciprocal
  binding; publisher/readback/idempotency; switches. Human `U` paths are never
  granted.
- **Test:** compromise harness attempts `/:rw`, `U` path, profile path,
  cross-tenant path, and DELETE. Broker must reject all except the unavoidable
  DELETE permitted inside an active bot write capability; that residual is
  documented and bounded to `B`.

### Stolen or stale session

- **Risk:** bearer continues writing after tier downgrade or device loss.
- **Mitigation:** Core owner list/revoke API, Ring session UI, expiry, broker
  revalidation, downgrade waits for revoke, no write sessions before support.
- **Test:** publish succeeds, Ring revokes ID, the same session gets 401 and the
  tenant becomes `reauthorization_required` without retrying through a key.

### Malicious prompt in a feed/tool result

- **Risk:** content tells the model to reveal secrets, change settings, or call
  a write tool.
- **Mitigation:** feed/tool content is untrusted data; Bot Kit injection
  detector and tool screen; model has no write session; typed proposal output;
  publisher revalidation and outbound scrub.
- **Test:** injection corpus in post, profile, tag, web result, and Scout field;
  assert no policy/tier change, no secret-shaped output, and no publish row.

### Provider data exposure

- **Risk:** public social context and prompts leave Synonym; provider retains
  them.
- **Mitigation:** explicit provider/egress UI; public-only launch context;
  bounded minimization; no memory bodies beyond necessary fields; self-hosted
  exit; no hidden fallback to another provider.
- **Test:** outbound proxy captures every provider request and compares it to an
  allowlist; forbidden-memory fixtures must never egress. Provider failure
  yields a notice, not fallback to an unselected provider.

### Public-memory leakage

- **Risk:** user treats bot memory as private or stores a secret.
- **Mitigation:** “Public bot memory” UI, closed schemas, no free-form memory,
  deterministic secret/credential rejection, export visibility, direct public
  GET test.
- **Test:** attempt every forbidden category and encoded secret corpus; no PUT.
  Positive test fetches every accepted memory object without authentication to
  prove the UI description is honest.

### Cross-tenant leakage

- **Risk:** a shared worker, cache, SQL query, or session broker uses tenant A
  data for B.
- **Mitigation:** immutable tenant context, RLS, tenant composite keys,
  no personalized shared cache, tenant broker namespace.
- **Test:** two-tenant canary suite plus concurrent 100-request stress and
  forced worker reuse; byte-search outputs/logs and inspect SQL rows.

### Sybil and bot amplification

- **Risk:** cheap bot identities flood tags/posts or manufacture corroboration.
- **Mitigation:** bots receive no privileged distribution; ordinary follows,
  blocks, graph distance, Homegate/signup cost, per-bot budgets, loop guards,
  bot badge, attributable tags. Claim counts retain claimant diversity and
  cluster context.
- **Test:** 100 fresh bots repeat one tag and mention one another. Results must
  report claimant/cluster facts, enforce loop/rate caps, and never label the
  claim true or trusted.

### Forged operator identity

- **Risk:** a bot sets `automation.operator = U` without U's consent.
- **Mitigation:** reciprocal `U -> B` binding; unpaired profile is rendered as
  an unverified operator claim.
- **Test:** profile-only claim, binding-only claim, mismatch, revoked binding,
  and matching pair.

### Destructive or over-broad model action

- **Risk:** model emits arbitrary JSON/path or combines settings into an
  unexpected destructive action.
- **Mitigation:** model returns typed proposals only; App maps each setting to
  an existing controller; publisher supports an allowlist of bot object kinds;
  deletes are absent from the launch action catalog.
- **Test:** path traversal, unknown key, stale diff, mass-delete wording,
  malformed post ID, and model output containing a raw URL/path.

### Kimi audit scope

The required external audit covers:

- Ring creation, selection, AuthToken, list/revoke UI, and device-loss flow;
- Core expiry/list/revoke routes, owner proof, replay resistance, session
  persistence, capability matching, and `w`/DELETE blast radius;
- App second-session isolation, request binding, reciprocal owner binding,
  approval queue, and all user-key publication paths;
- broker AEAD/KMS, secret storage, logs, Unix socket authorization, import and
  revalidation;
- Bot Kit prompt injection, tool screening, NLQ asker binding, budgets,
  switches, publish request, path checks, secret scrub, and cross-tenant
  isolation; and
- provider egress and memory schema rejection.

Every audit finding needs a file path, exploit/failure, and fix. P0/P1
introduced by the wave blocks shipping. The parent fixes or explicitly waives
lower findings with reason and reruns the proof.

## 11. **Delivery plan**

### Phase 0 — one-week staging spike

**Goal:** prove useful read-only Pubchi with no hosted Pubky session.

**Build:**

- `pubky-ai-bot-pubchi`: tenant/request schema, request-object verifier, Bot Kit
  NLQ adapter that overrides `asker = U`, feed candidate endpoint, fixed
  budgets, no publisher.
- `pubky-app` BitcoinErrorLog worktree: flagged chat panel, enrollment of
  manually chosen `B/U`, read-only query, feed preview and Apply through
  existing `FeedController`.
- Ring: use existing Add Pubky and auth UI; no Ring code is required for the
  first proof.

**Proof gate:**

1. staging user creates `B` in Ring;
2. matching profile/binding fixtures or App-written public objects enroll it;
3. “who tagged me?” returns evidence scoped to `U`;
4. “make a two-hop bitcoin feed” round-trips through installed
   `PubkyAppFeed` validation and installs through App;
5. server process environment and network trace show no Pubky key/session and
   no homeserver PUT;
6. fake `asker`, expired request, changed body hash, Scout outage, prompt
   injection, and unsupported likes all fail safely.

**Effort:** one engineer-week.
**Dependencies:** released Bot Kit/NLQ and staging Nexus/Scout only.
**Upstream:** none; entirely in BitcoinErrorLog worktrees, no remote writes
required for proof.

### Phase 1 — identity and portable public configuration

**Goal:** real bot enrollment, reciprocal ownership, public-memory schemas,
export/import.

**Build:**

- release/bump the specs automation proposal;
- App bot profile rendering and binding verification;
- dedicated local bot-session service;
- validated memory editors and direct homeserver reads/writes;
- export/import manifest across two staging homeservers.

**Proof gate:** schema contract vectors in Rust/JS/App; profile old-client
compatibility; forged operator negative tests; export/import hash equality;
public unauthenticated GET demonstration; forbidden-memory rejection.

**Effort:** 2–3 engineer-weeks.
**Dependencies:** specs version decision and App package bump.
**Upstream:** BitcoinErrorLog forks can prove all behavior. Official release
requires `pubky-app-specs` and App maintainers to accept/version it.

### Phase 2 — revocable sessions and assisted mode

**Goal:** revocable optional background-suggestion sessions under `B`, with all
user publication client-side.

**Build:**

- rebase and harden `pubky-core` `feat/session-revocation`;
- expose owner list/revoke in the SDK bindings Ring uses;
- Ring active-session UI with capability and expiry display;
- Rust session broker and optional background-suggestion scopes;
- App approval queue and controller adapters for posts, feeds, tags, and
  settings.

**Proof gate:** Core unit/e2e expiry and revoke suite; Ring device live proof;
broker restart using encrypted session export; revoke then 401; assisted draft
to user publish with authorship `U`; host attempts to write `U` and canonical
`B` post paths rejected; Kimi SHIP or resolved findings.

**Effort:** 4–6 engineer-weeks across Core, Ring, App, and Pubchi.
**Dependencies:** Phase 1 artifacts; Core branch accepted and released.
**Upstream:** fork-only integration is possible on staging. Production needs
upstream Core/homeserver and Ring release adoption.

### Phase 3 — launch capabilities and quality beta

**Goal:** all Section 7 capabilities in read-only/assisted mode.

**Build:** semantic Tagky suggestion, missed cursor, follower snapshots,
settings command catalog, proactive suggestion scheduler, capability-specific
eval sets, App VRT/E2E.

**Proof gate:** capability tests listed in Section 7; ≥90% required-source
retrieval top-5; ≥95% reviewed material claims supported; zero forbidden-memory
egress; zero invented unsupported graph relationships; two-tenant leakage
suite; kill-switch drill.

**Effort:** 4–5 engineer-weeks.
**Dependencies:** Phase 2 for hosted background suggestions; on-demand
capabilities can ship after Phase 1.
**Upstream:** no Nexus schema change required. Nexus team involvement is
needed only for capacity/SLA, not `/pub/pubchi.app/` indexing.

### Phase 4 — autonomous bot-authored posts and tags

**Goal:** selected graduated formats publish as `B`.

**Build:** separate post/tag sessions, per-tenant publishers, format
graduation state, publish/readback/idempotency, revoke and device-loss drills.
No autonomous user-authored publishing.

**Proof gate:** Bot Kit publish contract including crash-after-PUT, duplicate,
stale policy, switch race, malformed path, cross-tenant session, revoked
session, and host compromise attempts; production-like kill drill; backup and
restore of `B`; Kimi and independent strongest-tier reviews.

**Effort:** 3–4 engineer-weeks after Phase 3.
**Dependencies:** Core/Ring revocation production release, confirmed bot-key
backup, and one format meeting assisted accuracy/rejection thresholds.
**Upstream:** production depends on Core/Ring. A create-only capability would
reduce risk but is not required for a small bot-only beta if John accepts the
documented delete blast radius.

### Phase 5 — multi-tenant hardening and self-hosted exit

**Goal:** hosted beta and credible single-tenant exit use the same contract.

**Build:** RLS, tenant session broker namespaces, KMS rotation, deployment
profiles, two-tenant canaries, operator dashboards without content, self-host
guide, local/QVAC benchmark harness.

**Proof gate:** concurrent isolation suite; KMS/session rotation; restore;
per-tenant/global budget and switch drills; hosted versus self-host contract
parity; disaster recovery from encrypted DB plus KMS backup.

**Effort:** 3–5 engineer-weeks plus operations.
**Dependencies:** Phase 2 broker and Phase 3 load measurements.
**Upstream:** none for self-host/host mechanics; production operations ownership
is required.

### Explicit non-dependencies

- Collections are already shipped.
- Arena is not required to launch personal Pubchi; it is a later reputation and
  comparison surface.
- Locks/Paykit are not required until paid capabilities.
- Nexus need not index `/pub/pubchi.app/`; direct homeserver reads are the
  intended Stage 4 memory path.
- Private storage is not required for public-safe memory, but private memory
  and BYOK credential storage do not ship without it.

## 12. **Open decisions for John**

1. **Product name.** Keep “Pubchi” or choose a public name before App strings
   and specs policy URLs stabilize.
   **Recommendation:** keep Pubchi through beta; it communicates personal,
   persistent ownership better than a generic assistant name.

2. **Default hosted provider.** Which approved provider receives public graph
   context, and may users choose among Synonym-paid providers?
   **Recommendation:** one documented default at launch, one explicit
   self-hosted exit, no silent fallback. Add hosted provider choice only after
   each provider passes the same eval and data-retention review.

3. **Bot key granularity.** One bot key per user, or a key per capability?
   **Recommendation:** one `B` per user for coherent identity/reputation, with
   separate revocable sessions for state, posts, and tags. Multiple keys would
   fragment reputation and confuse blocking; capability isolation belongs in
   sessions.

4. **Reciprocal owner verification.** Should App require `U -> B` before
   showing “Operated by U”?
   **Recommendation:** yes. The specs `automation.operator` field is
   self-asserted and must render as an unverified claim without reciprocity.

5. **Autonomous beta risk.** Is bot-only deletion exposure under Core's current
   combined `w` action acceptable, or must Core add create/update/delete
   separation first?
   **Recommendation:** permit a small reversible beta only after revocation,
   backup, and publisher gates; require finer actions before broad autonomous
   rollout.

6. **Public memory default.** Enable follower snapshots and missed cursors by
   default even though they are public?
   **Recommendation:** missed cursor on by default with a clear label; follower
   history opt-in. Both are derived from public data, but longitudinal memory
   changes the privacy expectation.

7. **Autonomous launch formats.** Which single format may graduate first?
   **Recommendation:** a bot-authored weekly “what I missed” summary offered as
   an assisted draft first. Do not begin with auto-tagging, because tags alter
   other people's graph context and create greater amplification risk.

## 13. **Agent Choreography**

**Concurrency cap:** 6 simultaneous agents (Cursor Tasks and OpenCode processes
combined). This is a ceiling, not a target. One agent per worktree. Device-bound
Ring work runs in one stream at a time; service/spec work proceeds around it.

**Model policy:** resolve live models at launch. Use the newest available
`cursor-grok-*` at the lowest sufficient effort for exploration,
implementation, tests, and shell work. Use a different family or strongest
reasoning tier for architecture/integration review. Use the newest flagship
Kimi available through OpenCode for every sensitive audit; there is no Cursor
substitute.

### Dependency ledger

- `D0`: accepted `pubchi-design.md` and versioned schema fixtures.
- `D1`: Phase 0 API contract and negative test matrix.
- `D2`: Phase 0 service commit in `pubky-ai-bot-pubchi`.
- `D3`: Phase 0 flagged App commit in a `pubky-app` worktree.
- `D4`: Phase 0 staging proof report with network trace.
- `D5`: released/versioned automation specs artifact.
- `D6`: Core revocation commit rebased with green unit/e2e proof.
- `D7`: Ring list/revoke live-device proof.
- `D8`: broker session contract and Kimi-approved audit bundle.
- `D9`: assisted App integration and approval E2E.
- `D10`: capability eval report and kill-switch drill.
- `D11`: autonomous publish contract, backup/revoke drill, and Kimi SHIP.

No wave starts from “after Phase N”; it starts only when its named artifacts
exist and the parent has opened the files/outputs and rerun the cheap proof.

| Wave | Agents (max 6) | Repos/worktrees | Model tier | Effort | Depends on | Proof |
|---|---|---|---|---|---|---|
| 0 | contract-author, schema-author | Pubchi, disjoint worktrees | latest Grok, standard | M each | D0 | request/feed/result contracts; every schema positive + forbidden-field negative test |
| 1 | service-spike, app-spike | Pubchi + App | latest Grok, standard | M each | D1 | service unit/integration; App typecheck/VRT; no session/key imports |
| 2 | staging-integrator | Pubchi; App/device exclusively | latest Grok, standard | M | D2, D3 | six Phase 0 live proofs; agent opens and describes chat, feed preview, and network trace |
| 3 | phase0-reviewer | read-only diff review | strongest/different family | S | D4 | architecture, dead code, callers, false claims, and negative-gate verdict |
| 4 | specs-implementer, core-revocation, ring-sessions | Specs + Core + Ring, separate worktrees | latest Grok, standard/high | L, L, L | D4 | specs vectors; Core revoke e2e; Ring list/revoke live proof; halfway checkpoint is each narrow unit suite green |
| 5 | kimi-core-ring | OpenCode on staged Core/Ring diffs | newest flagship Kimi, high | M | D6, D7 | audit expiry, owner proof, replay, capability UI, device loss; all P0/P1 fixed |
| 6 | broker-implementer, assisted-service, assisted-app | Pubchi broker + Pubchi TS + App, separate worktrees | latest Grok, high | L each | D5, D6, D7 | broker restart/revoke; assisted authorship; approval E2E; halfway checkpoint is contract happy path + revoke negative |
| 7 | integration-review, kimi-assisted | read-only strongest review + OpenCode Kimi | strongest different family + Kimi | M each | D8, D9 | cross-repo review; Kimi key/session/approval/publish verdict; parent reruns cheap proofs |
| 8 | capabilities, app-surfaces | Pubchi + App worktrees | latest Grok, standard | L each | D9 | Section 7 evals, VRT production roots, E2E, no forbidden memory; halfway checkpoint is three capabilities green |
| 9 | tenant-hardening, autonomous-publisher | Pubchi disjoint worktrees after stable contract | latest Grok, high | L each | D10 | two-tenant poison test; publish replay/crash/switch/revoke suite; halfway checkpoint is isolation negative test |
| 10 | kimi-autonomy, superior-review | OpenCode Kimi + strongest independent reviewer | newest flagship Kimi + strongest different family | M each | D11 candidate | session broker, path auth, publisher, prompt/provider privacy, cross-tenant verdict |
| 11 | parent integration | parent only | n/a | M | all accepted artifacts | remotes verified; proofs rerun; commits/merges; no remote writes without user authorization |

**Required negative evidence before baselines:** each evidence-producing wave
must deliberately alter one expected tenant, capability, path, hash, or
production-component marker and show that its gate fails. Only then may it
generate VRT/eval baselines.

**Artifact verification:** before dispatching a dependent wave, the parent:

- reads at least two screenshots from different surfaces and compares unique
  hashes to file count;
- reads literal test command output;
- checks build artifact existence and SHA-256;
- opens reports and counts expected cases;
- runs `git status --short` and `git log -1`; and
- reruns lint/typecheck or the cheapest relevant contract proof.

**Kimi audit:** required in waves 5, 7, and 10. Resolve the newest flagship with
`opencode models moonshotai` at launch. Sensitive file set includes Core
session/auth/capabilities, Ring key/auth/revoke UI, App bot-session/approval
paths, broker secret encryption and transport, Bot Kit NLQ/policy/security and
publisher adapters, provider egress, and memory privacy validators. If Kimi
cannot run, stop; the wave does not ship.

**Independent review:** reviews use a stronger model or different family from
the implementer and cover regressions, entire-workspace callers, tests,
documentation, and dead code. Code is removed as dead only after searching the
entire workspace and proving no caller.

**Parent-only:** user communication, plan edits, commits, merges, all remote
git/GitHub writes, secret handling, audit finding acceptance/waiver, and final
integration.

**Remote rule:** agents never run `git push`, `gh pr create`, or any remote
write. Any future upstream repository action requires John's explicit approval;
BitcoinErrorLog fork work remains the default.

**Kill rule:** an agent that reaches its effort estimate without proof stops
and returns diagnosis plus partial artifacts. It is not silently relaunched on
a larger model. Three fix/review rounds are the maximum; unresolved complex
autonomy is cut back to read-only/assisted, not waved through.

**Accounting at each close:** agents/models used, review rounds, false-claim
rework, ready-item idle time, device hours, proof commands, Kimi spend, and
remaining upstream dependency.
