# Persona runtime contract

Phase 1 enables one immutable persona, `jeb`, without declaring behavior that
the runtime does not enforce.

## Pack and binding schemas

`personas/<id>/pack.yaml` is identity-free and portable. It contains:

- immutable `schema_version`, `id`, and semantic `version`;
- disclosure kind used by profile, identity answers, and long-form output;
- the assistant role label and thread-intro template used byte-for-byte;
- the capability allowlist used at model-schema and execution gates.

`personas/<id>/binding.yaml` is operator-owned. It attaches one pack version to
public account/profile copy. Publisher key material never enters either file;
publisher, budgets, and switches are added to binding-side deployment/database
contracts only when their enforcing PRs land.

Both schemas are strict. `runtimePackContract()` and
`runtimeBindingContract()` read every schema leaf, and tests require exact
schema/runtime-consumer parity. `loadPersonaPack()` loads and verifies a pack
without any binding, profile, key, database, or Jeb-only tool dependency.

Per the no-unenforced-field rule, the current pack contains only fields consumed
today. The corpus namespace is pack-owned, controls the retrieval path filter,
and is recorded with every answer. `global` excludes all `personas/` paths; a
`persona/<slug>/<version>` namespace includes only `personas/<slug>/`.
Tag vocabulary, safety policy, and evaluation
references are added by their enforcing PRs, always as new `PersonaPackSchema`
sections. They never alter `PersonaBindingSchema`. Enforced persona budgets are
binding-owned. Switches, publisher, key, and profile/account controls remain
binding-side concerns.

## Content address

`pack.snapshot.sha256` independently addresses `pack.yaml`.
`persona.snapshot.sha256` covers the pack, binding, and validated profile
template. All must be regular files inside the persona directory; symlinks,
absolute paths, traversal, missing files, and hash drift fail startup.

The parsed snapshot is deep-frozen. Every producer of reason work copies
`{id, version, hash}` into the work payload: ingest stamps the loaded runtime
persona; `--role requeue` (with or without `--replace`) keeps the snapshot
recorded for the mention (answer evidence first, then the routing work item)
and stamps the runtime persona only when none was recorded. A recorded
snapshot the runtime cannot serve is refused before any row is touched; it is
never rewritten to another persona. Reason rejects missing, malformed,
unknown, or drifted snapshots before answering, logs a fixed event, increments
a bounded metric, and marks the work failed. Every reply evidence row the
reason worker writes (model answers, canned and deterministic replies,
fallback replies, policy notices, opt-out confirmations) stores the same
snapshot; publisher claims resolve it through the evidence reference and
refuse a missing or mismatched snapshot before any PUT. Standalone,
collection, and weekly rows are operator-approved and bypass the persona
check by design. The kill-switch drill's reply and generation probes carry the
runtime snapshot so they reach the switch gates.

## Capability containment

Pack capabilities are allowlist-only and deny by omission. Effective model
tools are the intersection of:

1. intent tools;
2. the persona capability expansion;
3. deployed tools.

Denied tools are absent from model schemas and rejected again at execution.
Jeb allows global knowledge and denies raw Scout, persona knowledge, and
standalone publication by omission. `knowledge_global` is valid only with the
`global` namespace; `knowledge_persona` is valid only with the pack's own
`persona/<slug>/<version>` namespace. Its `global` namespace preserves the
existing general corpus while excluding every persona corpus.

Global knowledge excludes `personas/` paths. Persona knowledge includes only
`personas/<slug>/`; the pack schema rejects cross-persona slugs and mismatched
knowledge capabilities.

## Byte-equivalent Jeb behavior

Jeb’s pack-driven assistant role/thread intro and binding-driven system prompt
are byte-identical to the prior constants. The pack disclosure and bound profile
and deterministic identity answers identify an AI role operated by Synonym.
Deep output carries the same platform disclosure footer.

The profile remains `status=automated` until App Specs provides richer
machine-readable automation metadata.
