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

## Content address

`pack.snapshot.sha256` independently addresses `pack.yaml`.
`persona.snapshot.sha256` covers the pack, binding, and validated profile
template. All must be regular files inside the persona directory; symlinks,
absolute paths, traversal, missing files, and hash drift fail startup.

The parsed snapshot is deep-frozen. Ingest copies `{id, version, hash}` into
every work payload. Reason rejects missing, malformed, unknown, or drifted
snapshots before answering, logs a fixed event, increments a bounded metric,
and marks the work failed. Evidence stores the same snapshot; publisher claims
resolve it through the evidence reference and refuse a missing or mismatched
snapshot before any PUT.

## Capability containment

Pack capabilities are allowlist-only and deny by omission. Effective model
tools are the intersection of:

1. intent tools;
2. the persona capability expansion;
3. deployed tools.

Denied tools are absent from model schemas and rejected again at execution.
Jeb allows global knowledge and denies raw Scout, persona knowledge, and
standalone publication by omission.

Global knowledge excludes `personas/` paths. The separate
persona-knowledge capability is introduced only with its ingestion and
retrieval implementation.

## Byte-equivalent Jeb behavior

Jeb’s pack-driven assistant role/thread intro and binding-driven system prompt
are byte-identical to the prior constants. The pack disclosure and bound profile
and deterministic identity answers identify an AI role operated by Synonym.
Deep output carries the same platform disclosure footer.

The profile remains `status=automated` until App Specs provides richer
machine-readable automation metadata.
