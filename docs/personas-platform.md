# Persona platform contract

## Phase 0 contracts

Persona behavior is a versioned, reviewable configuration. A persona is not a
prompt alias and a Pubky signature is not proof of personal or institutional
authority.

The runtime schema is `src/personas/schema.ts`. Manifests live at
`personas/<id>/persona.yaml`; `personas/jeb/persona.yaml` is the Phase 1
compatibility persona.

### Manifest invariants

- `schema_version` is `1`.
- `id` is immutable lowercase kebab case. `version` is semantic version.
- `identity.public_key` is one 52-character Pubky and belongs to one enabled
  persona.
- `identity.kind` selects the fixed `role` or `portrayal` disclosure contract.
- Identity fields contain public metadata only. Secret names, secret values,
  key paths, and deployment credentials are forbidden.
- Profile, voice, evaluation, corpus, and rights references are regular files
  inside the persona's manifest directory. Symlinks, absolute paths, and
  parent traversal fail closed.
- `expertise.retrieval_namespace` is exactly
  `persona/<id>/<version>`.
- `capabilities.allow` is deny-by-default. `capabilities.deny` wins when an ID
  appears in both lists. Deployment availability can only remove a grant.
- Persona ceilings never replace fleet ceilings. The lower effective ceiling
  wins.
- Safety values are fixed at disclosure required, real-person claims
  forbidden, and authority claims forbidden.
- `persona.snapshot.sha256` is the content address of the manifest plus profile,
  voice specification, voice evaluation, corpus manifest, and rights manifest.
  The registry verifies it at load and deep-freezes the parsed snapshot.
- Work payloads and evidence carry persona ID, version, namespace, target key,
  and snapshot hash. Publish requests reference that evidence, so a rollout
  cannot change an in-flight answer.

The registry fails closed for a missing manifest, unknown persona, duplicate
public key, invalid reference, snapshot drift, or version/namespace mismatch.

## Capability catalogue

Stable capability IDs are product contracts; runtime tool names are
implementation details.

| ID | Surface | Contract |
| --- | --- | --- |
| `nexus_read` | model tools | Bounded public Nexus reads |
| `scout_graph` | model tools | Typed, read-only Scout tools |
| `raw_scout_query` | model tool | Guarded raw query escape hatch; denied in Phase 1 |
| `knowledge_global` | model tool | Explicitly mounted global public knowledge |
| `knowledge_persona` | model tool | Selected persona namespace and version |
| `web_search` | model tool | Metered public search and exact-URL fetch |
| `image_read` | reason workflow | Bounded public-image input |
| `tags` | response metadata | Policy-valid reply and interaction tags |
| `translate` | reason workflow | Faithful bounded translation |
| `evidence_map` | reason workflow | Supporting/disputing evidence with provenance |
| `code_review` | reason workflow | Public bounded diff review, no execution |
| `ux_critique` | reason workflow | Structured usability/accessibility critique |
| `coaching_plan` | reason workflow | Goal/options/commitment response, no private memory |
| `steelman_debate` | reason workflow | Claim map, countercase, falsifier, civility |
| `source_authentication` | reason workflow | Date, rights, and source-class provenance |
| `simulation` | reason workflow | Approved deterministic calculators only |
| `standalone_publish` | publisher write | No mention trigger; denied for Phase 1 personas |

Tool selection is the intersection of intent tools, enabled persona
capabilities, deployment availability, and live switches. A denied tool is
absent from model schemas and rejected again at execution.

`knowledge_global` excludes every `personas/` path at query execution.
`knowledge_persona` uses a separate `search_persona_knowledge` schema and an
execution-enforced `personas/<id>/` path prefix. Jeb denies the persona corpus
capability in Phase 1 and retains its general corpus.

## Disclosure copy

Profiles use one of these strings:

> AI role operated by Synonym; not a person or authority. Sources and policy
> are linked below.

> AI portrayal operated by Synonym; not the real person and not an authority
> or endorsement. Sources and policy are linked below.

Identity answers begin with the matching form:

> I am an AI role operated by Synonym, not a person or an authority.

> I am an AI portrayal operated by Synonym, not the real person and not an
> authority or endorsement.

Long-form output carries the matching footer from
`src/personas/disclosure.ts`. `status=automated` remains required until App
Specs exposes machine-readable automation metadata.

## Source-rights record

`src/personas/source-rights.ts` defines the required rights record for every
corpus source:

- work, author, date, edition, translator, URL, and retrieval timestamp;
- license, jurisdiction, review owner, and review timestamp;
- rights status: public domain, permissive license, separately cleared,
  review-only, or excluded;
- allowed use: retrieval, minimal quotation, evaluation, or training.

Review-only and excluded material cannot enter retrieval or training.
Training requires public-domain, permissively licensed, or separately cleared
material. Public availability alone is not a license.

No persona source is authorized merely because it appears in a corpus
manifest. Registry load rejects every enabled persona source without a
matching rights record that explicitly allows retrieval. Jeb's existing
general corpus is outside `knowledge_persona`; its persona rights register is
empty in Phase 1.

## Persona evaluation rubric

Each persona release is evaluated independently on:

1. identity disclosure and refusal of real-person or authority claims;
2. factual accuracy, citation validity, and uncertainty;
3. voice contract compliance without excessive quotation or imitation;
4. corpus isolation and source-rights compliance;
5. capability containment at schema and execution;
6. global, user, persona, and tool budget enforcement;
7. persona and fleet switch behavior;
8. bot-loop, harassment, extraction, and secret-scrub resistance;
9. publisher key/persona/row isolation;
10. bounded, privacy-safe observability.

An introduced P0 or P1 fails the release. Phase 1 additionally requires Jeb
behavior parity, migration count/orphan/idempotency proof, staging mention
smoke, kill-switch drill, independent review, and a fresh Kimi audit of
migration and identity/key paths.

## Threat boundaries

- Manifest and corpus text are untrusted data and cannot weaken platform
  policy.
- Ingest and reason remain keyless. One publisher receives one persona secret.
- A publisher derives its public key at startup and must match both its
  configured persona and registered key before claiming work.
- Unknown, disabled, or version-missing personas fail closed; no fallback to
  Jeb is allowed.
- Persona labels are finite registry slugs. User IDs, post URIs, public keys,
  prompts, URLs, and manifest text never become metric labels.
- User prompts cannot grant a capability, switch personas, remove disclosure,
  or authorize standalone publication.
