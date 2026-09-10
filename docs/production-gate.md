# Production resource-publishing gate

Production resource publishing writes universal tags under Jeb's own identity, at `/pub/jeb.pubky.app/tags/`, on the production homeserver. This document is the operating procedure. The configuration contract itself is in `docs/external-resource-configuration.md`.

Nothing here authorizes a first write on its own. The gate is deliberately conjunctive: every clause below must hold, and any one of them failing stops the run before it reaches the model, Nexus, or the homeserver.

## What authorizes a production run

**Two-value environment gate.** The service environment must carry both `JEB_RESOURCE_TARGET=production` and an explicit, non-empty `JEB_RESOURCE_CONFIG_VERSION` equal to the signed production version compiled into the running build. A `--target production` flag alone cannot authorize anything: the flag is checked against the same environment gate, so a staging deployment cannot be pointed at production from the command line. The default config version is a staging value and is rejected for production, which means an operator has to deliberately name a reviewed configuration revision.

**Build stamp.** `dist/build-stamp.json` must match the compiled config version, the compiled pin-set version, the current commit, and a hash of the deployed `dist` tree. The stamp carries no target, because one immutable image serves both targets.

**Pinned profile.** The Nexus URL, homeserver public key and host, expected publisher, and pubkyauth relay all come from the compiled production profile. Environment URLs are ignored for this role.

**Real database.** A production run requires a real `DATABASE_URL`; the placeholder used by keyless staging discovery is refused. The runtime never executes DDL. At each invocation it performs the migrator's read-only readiness check and verifies that both resource tables carry every column it reads, then exits before any Nexus, model, or key access if either is false. Migrations are applied by a separate job.

**Single writer.** The run takes a session-level PostgreSQL advisory lock keyed by a domain-separated hash of the expected publisher public key, and holds it through post-run verification. The loser of an overlap records `overlap_refused` and exits nonzero without spending anything. Every future writer to the same tag prefix must take the same lock.

**Spend ceilings.** The run reserves against the UTC-day row before any external call, and settles actual spend as it proceeds. See the spend section of the configuration document.

**Environment contract.** The key-bearing executor must carry exactly one non-empty bot key source and no other credential: no signup token, no admin token, no model or web key, no exported session, no authorization URL. A variable set to the empty string counts as present, because a deployment that names a credential it does not intend to use is a defect rather than an absence. The keyless planner must carry no bot key source at all.

**Scoped session.** The publisher never signs in with root capabilities. It mints a self-approved session scoped to `/pub/jeb.pubky.app/tags/:rw` and verifies, before any write, that the session's publisher matches the profile and that its grants both cover that scope and grant no more than it. A broader grant, a parent-app grant, a sibling path, an extra grant, or a non-`rw` action is refused and the session is signed out. There is no root fallback anywhere in this path.

**Host evidence.** A production write additionally requires the transport to report which host it actually reached, and that host must be the pinned production host. The installed SDK exposes only PKDNS public-key resolution, not the effective authenticated storage endpoint, so this predicate currently refuses every production execution. That is intentional: production stays closed until the SDK exposes the endpoint the authenticated request was sent to. Dry runs, planning, and every other gate above are exercisable today.

## Verifying the production homeserver pin independently

The production homeserver public key is checked in twice — as a constant in `src/outbound-gate.ts` and as a captured resolution fixture in `src/test-fixtures/production-homeserver-pkdns.json` — and a unit test resolves one from the other. Neither was copied from another repository's constant.

To re-verify by hand against the live network, resolve Jeb's identity through PKDNS and compare the answer to the fixture:

    npx tsx -e "import {Pubky} from '@synonymdev/pubky'; const p=new Pubky(); const hs=await p.pkdns.getHomeserverOf('9o6xrx8wgqu48dmb47uep6w3dgbwdnf5jgw83gbeuxg9yi7x444y'); console.log(hs?.z32())"

The output must equal the `publicKey` field of the fixture. If it does not, do not edit the constant to match: a changed homeserver for Jeb's identity is an incident, not a configuration update, and the difference must be explained before any production run.

## First production write

1. Confirm the deploy: the migration job succeeded, the runtime readiness check passes, and the running image's stamp matches the intended commit.
2. Run the family's discovery in shadow mode against production and read the plan. Shadow performs no writes and calls no homeserver.
3. Run the same family in publish mode without `--execute`. Publish is a dry run by default: it emits the plan and its `planSha256` and performs zero writes.
4. Review the plan: the resource count, the labels, the tag paths, and the write count. Every path must be under `/pub/jeb.pubky.app/tags/`.
5. Re-run the dry run and confirm the same `planSha256`. A differing hash means the input or the live state moved; start again at step 3.
6. Execute with the reviewed hash. The first production write additionally requires `--confirm-plan <sha256>` to equal the recomputed plan hash, so an unattended process cannot perform it.
7. Read the manifest row in `resource_runs` and the tag prefix listing. A nonzero exit or a `failed` status means at least one write failed; do not retry blindly, return to step 3.

## Reconcile and delete ceilings

Every production reconcile requires `--confirm-plan` equal to the recomputed plan hash, including the `retired` policy. Staging keeps its existing behaviour, where only `full` requires confirmation, so the pilot workflow is unchanged.

A production `full` reconcile is additionally bounded. The run may delete at most `min(50, floor(0.20 × listed))` paths. No single resource may lose more than half its listed tags. A resource whose desired label set is empty blocks the plan outright, and no override can bypass that guard: a model that proposes removing every label from a resource is a defect, not an instruction. The two ratio guards can be overridden only by `--allow-mass-delete` and `--allow-high-delete-ratio`, which are part of the hashed plan preimage — passing one changes the plan hash, so the override has to be reviewed and confirmed with the plan it belongs to and can never take effect unattended.

Deletes are further constrained by the per-path precondition: the path must come from the immutable listing, its current body must normalize to an accepted resource, recompute to the same path under this publisher, not be in the desired set, and either carry a retired label or fall under `full`. Another publisher's files are never listed and never deleted.

## Kill switch

Disable every production resource cron in Railway. Do not stop the main `jeb` service: it serves replies and holds the same identity.

Then prove quiescence rather than assuming it. Record the disable timestamp. Wait longer than the configured maximum run duration. Query `resource_runs` for production rows started after that timestamp and require zero, then for any row still `running` and require zero. Finally snapshot the tag-prefix listing twice, one full polling interval apart, and require identical path and body hashes. Cron being disabled is not evidence; homeserver and database observation is.

## Rollback

Rollback removes labels through the same reconcile path that wrote them; there is no separate delete tool.

Run the dry reconcile first, inside the production service with its existing secret reference:

    railway ssh --service <production-resource-service> -- node dist/main.js --role resources <family-command-and-input> --mode reconcile --target production --reconcile retired --retired <label> --expected-pk 9o6xrx8wgqu48dmb47uep6w3dgbwdnf5jgw83gbeuxg9yi7x444y

Review the plan, its scope, the counts, the protected set, and the hash. Then execute the same immutable input and configuration with the reviewed hash:

    railway ssh --service <production-resource-service> -- node dist/main.js --role resources <family-command-and-input> --mode reconcile --target production --reconcile retired --retired <label> --expected-pk 9o6xrx8wgqu48dmb47uep6w3dgbwdnf5jgw83gbeuxg9yi7x444y --confirm-plan <sha256> --execute

If a PUT succeeded and later verification failed, leave the cron disabled, keep the partial manifest, and rerun the dry reconcile against live state. If a DELETE returned 5xx after PUTs succeeded, do not compensate by deleting the new writes and do not blindly retry: the next confirmed plan determines the remaining work.

## Ledger reset

The spend ledger is operator-retained service data. Neither `resource_spend_day` nor `resource_runs` is owner-scoped identity state, so no identity-clear path wipes them; a schema-enumeration test re-raises that decision if one is ever added.

A stuck reservation — a run killed between reserving and settling — leaves reserved dollars on the current UTC day and can refuse later runs for the rest of that day. Confirm first that no run is actually in flight, using the quiescence procedure above, then reduce the day's `reserved_usd` for that target to zero and leave `actual_usd` untouched. Never reduce `actual_usd`: it is the record of money already spent, and lowering it raises the effective ceiling for the remainder of the day.

A row left in `running` after a confirmed-quiescent check is a crashed invocation. Close it as `failed` with a failure code; do not delete it, because the run may have written tags and the manifest is the only record of what it did.
