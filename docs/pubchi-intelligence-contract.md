# Pubchi intelligence contract

Pubchi accepts signed requests from the App and returns evidence and proposals for owner review. The App and the service share the following wire types.

| Type | Purpose | Stability |
| --- | --- | --- |
| `ExecutionScope` | Truthful executed time, graph, filters, and completeness metadata | Optional additive field on `PubchiAnswerV1` |
| `FeedDraftV2` | Strict App feed fields used by a proposal | Additive |
| `FeedProposalV2` | Create/update feed interpretation with explicit mapping decisions | Additive version 2 |
| `Scope` | Planner time and graph scope | New internal contract |
| `Ref` | Fixed backward-reference paths between plan steps | New internal contract |
| `Value` | Recursive scalar, reference, array, or record plan value | New internal contract |
| `Template` | Catalog-tool planner action | New internal contract |
| `Cypher` | Guarded composed-query planner action | New internal contract |
| `Knowledge` / `Web` | Bounded retrieval and search planner actions | New internal contracts |
| `Step` | One action in a bounded chain | New internal contract |
| `ConversationalPlan` | Strict answer, template, query, chain, or feed plan | New internal contract |
| `TOOL_OUTPUT_MANIFESTS` | Allowed output paths for reference resolution | New internal contract |
| `FEED_CATALOG` | Frozen feed parameter and authoring manifest | App-vendored |
| `GoldenCase` | Versioned planner-evaluation fixture format | New test contract |

The service uses `pubky-social-specs@1.0.0-rc.2`, matching the App. A signed
post target identifies the post across edits at `/pub/social/v1/posts/{id}`.
The public profile is `/pub/social/v1/profile.json`. Public evidence can refer
to a profile, post, tag, follow, or file. Feeds, bookmarks and mutes belong
to the owner's private tree. The service sends a feed proposal to the App,
which can save it after owner approval.

For a tag proposal, both ends hash the canonical JSON projection of the same
target. A post projection includes the versionless URI, owner, content and
stored post kind (such as `note` or `article`). A profile projection includes
the URI, owner, name and nullable bio. An edit can make a proposal stale
before the App applies it.

`Cypher.rationale` (maximum 240 characters) and `Scope.window.label` (maximum
80 characters) are model-produced text. Any UI rendering these fields must
escape them as text; neither field is trusted markup.

## Pubchi assistant provenance

`PubchiAnswerV1` keeps its existing graph fields and accepts additive optional
`basis` and `citations` fields. `basis` is `graph`, `knowledge`, `model`, or
`mixed`; it describes provenance, not confidence. A model or knowledge answer
uses a strict scope whose graph kind is `none`. A mixed answer may also
include graph evidence and its executed scope. A model-only answer has no
citations.

`basis` and the feed-catalog route are always-on additive changes. Existing App
consumers tolerate these additive fields and the catalog citation without
changing the existing v1 graph fields.

Each citation has `kind` (`knowledge` or `web`), a title of at most 160
characters, an HTTPS URL of at most 512 characters, and optional bounded
`source_id`, `corpus_version`, and screened snippet fields. At most eight
citations are accepted. The App renders returned citations as outbound
sources; the model cannot invent a source URL.

## Signed conversation window

The signed ask body may carry `conversation.turns`: at most eight alternating
user/assistant turns, starting with `user`, with at most 600 Unicode code
points per turn and 4,800 code points total. Assistant turns retain their
optional basis and citations. The App drops the oldest complete pairs before
signing. The entire body remains covered by the existing v2 body hash and
signature.

The window is client-held and transient. Pubchi screens and delimits it as
untrusted input, never logs or persists it, and has no conversation ID,
provider thread, server transcript, or deletion endpoint. Invalid windows
are rejected as `SCHEMA_INVALID`; the App preserves its local draft.

## Knowledge and web plan actions

The internal conversational plan supports strict standalone or chain actions:
`knowledge` has a query of at most 300 characters and `k` from 1 to 6;
`web` has the same query limit and `k` from 1 to 5. Their only backward
reference paths are `sources[0].url`, `sources[0].title`,
`results[0].url`, and `results[0].title`, respectively. An `answer` plan
must declare `basis: model|knowledge|mixed`; it may carry bounded backward
`refs` to retrieved outputs.

## Feed catalog

`FEED_CATALOG` is the frozen manifest consumed by the no-Scout capability
answer and later App slices. It is authored from the same enum constants used
by `FeedProposalV2Schema` and lists `name`, `icon`, `tags`, `domain_tags`,
`reach`, `sort`, `layout`, and `content`, with one-line meanings and
authoring restrictions. `reach=followers` and `content=unknown` exist in the
specification but are not authorable by this App. Omitting `content` means all
content. Likes are not a supported sort.

`PUBCHI_FEED_PROPOSAL_V2` is the v2 kill switch for both signed `/v1/feed`
requests and the internal ask-to-feed handoff. When it is off, both paths use
the existing v1 feed flow. The internal handoff draft is not accepted from the
wire.

