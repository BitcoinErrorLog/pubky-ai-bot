# Persona runtime contract

Phase 1 enables one immutable persona, `jeb`, without declaring behavior that
the runtime does not enforce.

## Manifest schema

`personas/<id>/persona.yaml` contains only:

- immutable `schema_version`, `id`, and semantic `version`;
- public identity copy used by the system prompt and profile;
- disclosure kind used by profile, identity answers, and long-form output;
- the assistant role label and thread-intro template used byte-for-byte;
- the capability allowlist used at model-schema and execution gates.

The schema is strict. Unknown fields fail parsing. Budget ceilings, publisher
key binding, persona corpus/source-rights metadata, and tag vocabularies are
not part of this contract; they return only in the PRs that enforce them.

`runtimeManifestContract()` reads every schema leaf. Its regression test
compares all parsed manifest leaf paths with the runtime projection, so adding
an unread field fails the suite. `CAPABILITY_RUNTIME_CONSUMERS` separately maps
every capability ID to its concrete schema, execution, or workflow gate; the
suite requires exact catalogue/consumer/enum parity.

## Content address

`persona.snapshot.sha256` covers `persona.yaml` and the validated profile
template. Both must be regular files inside the persona directory; symlinks,
absolute paths, traversal, missing files, and hash drift fail startup.

The parsed snapshot is deep-frozen. Ingest copies `{id, version, hash}` into
every work payload. Reason rejects missing, malformed, unknown, or drifted
snapshots before answering, logs a fixed event, increments a bounded metric,
and marks the work failed. Evidence stores the same snapshot; publisher claims
resolve it through the evidence reference and refuse a missing or mismatched
snapshot before any PUT.

## Capability containment

Manifest capabilities are allowlist-only and deny by omission. Effective model
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

Jeb’s manifest-driven system prompt, assistant role label, and thread intro
are byte-identical to the prior constants. The manifest profile disclosure
and deterministic identity answers identify an AI role operated by Synonym.
Deep output carries the same platform disclosure footer.

The profile remains `status=automated` until App Specs provides richer
machine-readable automation metadata.
