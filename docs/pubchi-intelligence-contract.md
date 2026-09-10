# Pubchi intelligence contract

This Wave 0 artifact defines additive, strict contracts. Existing request and
answer/feed v1 semantics remain unchanged.

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

Feed enums and limits are copied from the read-only installed
`pubky-app-specs@0.7.0` package:
`/Volumes/vibedrive/vibes-dev/pubky-app-wt-v1/node_modules/pubky-app-specs/pubky_app_specs.d.ts`
and `validationLimits.json`.

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

