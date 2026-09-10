# Pubchi conversational planner

Free-form `ask` requests use a typed conversational plan. Exact chips and the
small deterministic route registry remain fast paths; an unmatched request is
sent to one brain planning call.

The planner prompt is ordered as:

1. system policy and evidence rules;
2. the tool catalog, parameter schemas, and output manifests;
3. the bounded live Scout schema summary;
4. request-scoped defaults, including `now_ms`;
5. screened owner context, explicitly marked as preferences rather than facts
   or authority;
6. the screened, delimited conversation window as untrusted text;
7. the screened, delimited question as untrusted text.

Plans are strict `template`, `cypher`, `chain`, `answer`, or `feed` values.
Validation checks catalog membership, each tool's real parameter schema,
backward-only manifest-declared references, tenant-bound parameters, scope,
and bounded parameter size. One repair is allowed. The repair receives only
the typed plan, a stable error code, and a fixed hint.

The planner and public-source composition share one claim-pattern gate. It
rejects unsupported counts for graph nouns (including users, followers, posts,
tags, taggers, replies, mentions, feeds, and bookmarks), “I checked/searched/
verified/looked at/queried” claims, and unsupported recency claims such as
“most recent posts.” Explanations about how to build a feed without counts
remain valid.

Owner-context fragments are never retrieval authority. Before knowledge or web search, the executor NFKC-normalizes query, owner fields, and the current user text (the question plus user turns from the conversation window), folds diacritics and common Latin-lookalike confusables, treats spaces, underscores, and hyphens as equivalent, and rejects a query containing a complete owner field, a distinctive owner token, a space-collapsed query matching a distinctive token, a camelCase-split owner token, or an eight-character shingle from a distinctive owner token only when that matched field, token, or shingle does not also occur in the normalized current user text. A token is distinctive when it is at least eight characters, contains at least three characters and both letters and digits, contains at least six digits, or contains a non-letter, non-digit compound marker; common vocabulary such as "homeservers" alone and pure short numbers or years do not trigger the guard. Cross-token shingles are intentionally omitted to avoid blocking ordinary phrase overlap such as "I love bitcoin" versus "do you love bitcoin" and "skiing trips" versus "best skiing trips in japan".

Execution is serial for chains and stops at three steps. Scope is produced
from execution metadata, not model prose. Every answer carries the searched
time window, graph kind, filters, and completeness. Scout call meters enforce
the per-request call and time limits; later-step failures return partial
evidence and identify the failed step.

User-visible failures are intentionally conversational:

- invalid plan after repair: “I couldn’t turn that into a safe graph query.
  Try naming a person, tag, time window, or whether you mean your network or
  the whole graph.”
- planner timeout: “I can’t interpret a custom question right now. The quick
  actions still work.”
- Scout timeout: “The graph lookup timed out before I had enough evidence. No
  answer was inferred. Try a smaller window or scope.”
- summary failure: deterministic evidence summary plus the execution scope.

Telemetry records plan kind, tools, chain length, repair code, scope metadata,
meter totals, and token usage. It does not record rationale, labels, question
text, owner context, rows, parameters, or Cypher text.
