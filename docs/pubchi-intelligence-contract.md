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
| `Step` | One action in a bounded chain | New internal contract |
| `ConversationalPlan` | Strict answer, template, query, chain, or feed plan | New internal contract |
| `TOOL_OUTPUT_MANIFESTS` | Allowed output paths for reference resolution | New internal contract |
| `GoldenCase` | Versioned planner-evaluation fixture format | New test contract |

Feed enums and limits are copied from the read-only installed
`pubky-app-specs@0.7.0` package:
`/Volumes/vibedrive/vibes-dev/pubky-app-wt-v1/node_modules/pubky-app-specs/pubky_app_specs.d.ts`
and `validationLimits.json`.

`Cypher.rationale` (maximum 240 characters) and `Scope.window.label` (maximum
80 characters) are model-produced text. Any UI rendering these fields must
escape them as text; neither field is trusted markup.

