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
public account/profile copy and to the persona budgets. Publisher key material
never enters either file; publisher and key controls are added to binding-side
deployment/database contracts only when their enforcing PRs land. Persona
switches live in the `persona_switches` table, not in either file.

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

## Persona switches

`persona_switches` rows are keyed by `(persona_id, name)`. A missing row is
off. `Store.personaSwitchOn(personaId, stage)` is true when the persona's
`global` row or its stage row is on; `Store.setPersonaSwitch` accepts only the
names in `PERSONA_SWITCH_NAMES`, a registered persona, a boolean, and a
non-empty actor, and writes through one static upsert.

Fleet switches still stop every persona. A persona switch stops only that
persona. Every gate fails closed: a store or query error throws before the
stage acts, and the publisher refuses when it has no store to read.

| Stage | Persona switches | Also stopped by | Boundary |
| --- | --- | --- | --- |
| ingest | `global`, `ingest` | fleet consumption gate | before each poll and before each mention is enqueued; the cursor does not advance past a blocked item |
| reason/model | `global`, `generation` | fleet `generation`/`global`, `JEB_DISABLED` | before claiming work, before the answer, and before every model and tool step |
| publish | `global`, `replies` | fleet `replies`/`global` | before claiming and again before each reply PUT |
| web | `global`, `web` | fleet `web` | in the `search_web` executor, before any budget row |
| Scout | `global`, `scout` | fleet `scout` | in every Scout executor, before any budget row |
| images | `global`, `images` | image capability, `JEB_IMAGE_ENABLED` | at answer start and before every image-bearing model call |
| tags | `global`, `tags` | fleet `replies`/`global`, `JEB_SELF_TAGS=0` | before reason composes tags, before each publisher tag pass, and before each tag PUT |

Switches are read on every loop tick: ingest every `DEFAULT_POLL_MS` (3 s)
and reason and publish every 40 ms, so a flip takes effect within one tick
and well inside 60 s. `src/personas/switch-drill.test.ts` proves this with
fake timers driving the production intervals.

## Persona budgets

`binding.budgets` ceilings are enforced in the same transaction as the fleet
ceilings, from the canonical ledgers. There are no aggregate counters.

- **Tokens.** Every text-only and image-bearing model call is admitted before
  the provider call by one `token_usage` reservation row sized to the call's
  hard upper bound. One transaction takes the fleet token-ledger advisory lock,
  expires stale reservations, locks the row being resized, and sums the
  reservation's UTC day for the fleet, fleet-user, persona, persona-user, and
  persona-image layers. Any layer refusal returns before a write, so no layer
  is partially charged. A persona answer without the ledger pool is refused.
- **Settlement.** Text settles to reported usage (zero included) and keeps the
  full reservation when usage is unknown. Provider errors release the text
  reservation. Image-bearing calls settle conservatively on error or unknown
  usage. Stale text reservations become `token_reserve_expired` and remain
  charged; stale image reservations are refunded. Settlement and resizing use
  the reservation's own UTC day.
- **Images.** `image_tokens_daily` counts whole image-bearing calls. When the
  image call does not fit, images are stripped and the text-only call is
  admitted separately; if that also does not fit, the answer fails with
  `token budget exceeded` before the provider.
- **Web and Scout.** `web_calls_daily` and `scout_calls_daily` are enforced in
  the same `web_queries`/`scout_queries` transaction as the fleet daily
  ceiling, using the same unit as the fleet ledger. Per-mention limits are the
  lower of the fleet and persona values.

Lock order is always: fleet ledger advisory lock, then the exact reservation
row. Token, web, and Scout ledgers use distinct advisory locks and never nest.

## Byte-equivalent Jeb behavior

Jeb’s pack-driven assistant role/thread intro and binding-driven system prompt
are byte-identical to the prior constants. The pack disclosure and bound profile
and deterministic identity answers identify an AI role operated by Synonym.
Deep output carries the same platform disclosure footer.

The profile remains `status=automated` until App Specs provides richer
machine-readable automation metadata.
