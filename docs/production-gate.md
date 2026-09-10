# Production resource-publishing gate

Production resource publishing writes universal tags under Jeb's own identity, at `/pub/jeb.pubky.app/tags/`, on the production homeserver. This document is the operating procedure. The configuration contract itself is in `docs/external-resource-configuration.md`.

Nothing here authorizes a first write on its own. The gate is deliberately conjunctive: every clause below must hold, and any one of them failing stops the run before it reaches the model, Nexus, or the homeserver.

## What authorizes a production run

**Two-value environment gate.** The service environment must carry both `JEB_RESOURCE_TARGET=production` and an explicit, non-empty `JEB_RESOURCE_CONFIG_VERSION` equal to the signed production version compiled into the running build. A `--target production` flag alone cannot authorize anything: the flag is checked against the same environment gate, so a staging deployment cannot be pointed at production from the command line. The default config version is a staging value and is rejected for production, which means an operator has to deliberately name a reviewed configuration revision.

**Build stamp.** `dist/build-stamp.json` must match the compiled config version, the compiled pin-set version, the current commit, and a hash of the deployed `dist` tree. The stamp carries no target, because one immutable image serves both targets.

**Pinned profile.** The Nexus URL, homeserver public key and host, expected publisher, and pubkyauth relay all come from the compiled production profile. Environment URLs are ignored for this role.

**Real database.** A production run requires a real `DATABASE_URL`; the placeholder used by keyless staging discovery is refused. The runtime never executes DDL. At each invocation it performs the migrator's read-only readiness check and verifies that both resource tables carry every column it reads, then exits before any Nexus, model, or key access if either is false. Migrations are applied by a separate job.

**Single writer.** The run takes a session-level PostgreSQL advisory lock keyed by a domain-separated hash of the expected publisher public key, and holds it through post-run verification. The loser of an overlap records `overlap_refused` and exits nonzero without spending anything. Every future writer to the same tag prefix must take the same lock.

**Spend ceilings.** The planner reserves against the UTC-day row before any model, Nexus, or fetch call, meters every model call and every cache hit (explicit zero) against that reservation, and settles at termination. Every run row carries a bounded lease with a heartbeat; a crashed run's row is reaped as `abandoned` by the next invocation and never reused, and its reservation stays in place until an operator reconciles it. See the spend section of the configuration document.

**Planner/executor split.** Publishing is two steps in two processes. The planner is keyless: `--mode plan --plan-out <file>` discovers and tags under the spend ledger and writes one canonical plan artifact (recursively key-sorted JSON, deterministic action order) containing every action — each PUT with its full tag-file body, each DELETE with its path and current label — plus the run's identity: command family, source id, tagger and model ids, config version, dist artifact hash, target, publisher, homeserver pin set, limit, every override flag, the listed-set digest, the ledger run id and reservation, the ledger-derived first-write state, the planner timestamp, and the ceiling evaluation. The planner prints the artifact's SHA-256. The executor — `--mode publish|reconcile --plan <file> --confirm-plan <sha256> --execute` — performs no discovery, no fetch, and no tagging: it re-hashes the artifact, compares the confirmed hash, verifies every identity field against the live process (a plan from another family, tagger, config version, dist build, target, publisher, pin set, limit, or override set refuses even with byte-identical actions), refuses a plan older than one hour, re-checks the delete ceilings from the artifact, and only then executes exactly those actions. Without `--execute` the executor verifies the plan and prints what would run. The old single-process publish/reconcile path is removed. Staging runs the identical two-step flow, so it remains a faithful rehearsal.

**Environment contract.** The key-bearing executor must carry exactly one non-empty bot key source and no other credential: no signup token, no admin token, no model or web key, no exported session, no authorization URL. A variable set to the empty string counts as present, because a deployment that names a credential it does not intend to use is a defect rather than an absence. The keyless planner must carry no bot key source at all; a present key source in a planner process is itself the refusal.

**Scoped session.** The publisher never signs in with root capabilities. It mints a self-approved session scoped to `/pub/jeb.pubky.app/tags/:rw` and verifies, before any write, that the session's publisher matches the profile and that its grants both cover that scope and grant no more than it. A broader grant, a parent-app grant, a sibling path, an extra grant, or a non-`rw` action is refused and the session is signed out. There is no root fallback anywhere in this path.

**Host evidence.** A production write additionally requires the transport to report which host it actually reached, and that host must be the pinned production host. The installed SDK exposes only PKDNS public-key resolution, not the effective authenticated storage endpoint, so this predicate refuses every production execution at transport construction. That is intentional: production stays closed until the SDK exposes the endpoint the authenticated request was sent to. What is reachable today, exactly: shadow discovery on either target, the keyless planner (including its ledger reservation and plan artifact) on either target, and full two-step execution on staging. What is not: any production PUT or DELETE, because no transport can supply host evidence. Staging remains the executable rehearsal target.

## Verifying the production homeserver pin independently

The production homeserver public key is checked in twice — as a constant in `src/outbound-gate.ts` and as a captured resolution fixture in `src/test-fixtures/production-homeserver-pkdns.json` — and a unit test resolves one from the other. Neither was copied from another repository's constant.

To re-verify by hand against the live network, resolve Jeb's identity through PKDNS and compare the answer to the fixture:

    npx tsx -e "import {Pubky} from '@synonymdev/pubky'; const p=new Pubky(); const hs=await p.pkdns.getHomeserverOf('9o6xrx8wgqu48dmb47uep6w3dgbwdnf5jgw83gbeuxg9yi7x444y'); console.log(hs?.z32())"

The output must equal the `publicKey` field of the fixture. If it does not, do not edit the constant to match: a changed homeserver for Jeb's identity is an incident, not a configuration update, and the difference must be explained before any production run.

## Verification

Every mutation is read back. A PUT is verified by reading the path and comparing the full tag body; a DELETE is verified by reading the path and requiring it to be gone. A run records `verified=true` only when every action read back — a readback mismatch is a bounded `readback_failed`, never a claimed success.

The Nexus check is recorded separately as `nexusVerified` counts (`checked`, `indexed`, `attempts`). Nexus indexes asynchronously, so a correct write can be invisible to Nexus for seconds after the homeserver accepted it: failing the run on that lag would produce false failures, and claiming Nexus state without looking would produce false confidence. The check is therefore bounded (at most 20 URIs, 3 attempts each, short backoff) and non-blocking — it never changes the run's verified flag or exit code — and exists so the operator can watch indexing catch up.

## First production write

1. Confirm the deploy: the migration job succeeded, the runtime readiness check passes, and the running image's stamp matches the intended commit.
2. Run the family's discovery in shadow mode against production and review its result. Shadow performs no writes and calls no homeserver.
3. Run the keyless planner and record the printed hash:

       node dist/main.js --role resources <family-command-and-input> --mode plan --target production --plan-out /tmp/jeb-plan.json --limit 1

   With the currently pinned SDK this succeeds: planning needs no session. Review the artifact — every action, the identity fields, the ceiling evaluation. Every PUT path must be under `/pub/jeb.pubky.app/tags/`.
4. Re-run the identical planner command and require the same `plan_sha256` (note the tag bodies embed a creation timestamp, so the hash is only stable within the same planning instant; what must be stable is the action set). A differing action set means the input or live state moved; start again.
5. Execute with the reviewed hash, inside the production service with its existing secret reference:

       node dist/main.js --role resources <family-command-and-input> --mode publish --target production --plan /tmp/jeb-plan.json --confirm-plan <sha256> --execute --expected-pk 9o6xrx8wgqu48dmb47uep6w3dgbwdnf5jgw83gbeuxg9yi7x444y

   The first production write is bound into the plan: the planner reads `resource_runs` for a successful production run with writes and records the result in the artifact, and the executor re-reads the ledger and refuses on a mismatch. An unattended process cannot perform the first write.
6. Do not expect step 5 to reach the homeserver with the currently pinned SDK: the host-evidence gate refuses the scoped transport because the SDK exposes no authenticated endpoint. Rehearse the full two-step procedure on staging until the SDK exposes that evidence.
7. Read the manifest rows in `resource_runs` (one planner row, one executor row) and the tag prefix listing. A nonzero exit or a `failed` status means at least one write failed; do not retry blindly, return to step 3.

## Reconcile and delete ceilings

Every production reconcile executes only a confirmed planner artifact: `--confirm-plan` must equal the artifact's SHA-256, including for the `retired` policy. Staging runs the same two-step flow. The planner refuses to write a violating plan, and the executor re-checks every ceiling from the artifact before any write.

A production `full` reconcile is additionally bounded. The run may delete at most `min(50, floor(0.20 × listed))` paths. No single resource may lose more than half its listed tags. A resource whose desired label set is empty blocks the plan outright, and no override can bypass that guard: a model that proposes removing every label from a resource is a defect, not an instruction. The two ratio guards can be overridden only by `--allow-mass-delete` and `--allow-high-delete-ratio`, which are part of the hashed artifact — passing one changes the plan hash, so the override has to be reviewed and confirmed with the plan it belongs to and can never take effect unattended.

Deletes are further constrained at execution time: the executor re-lists the prefix and requires the listed-set digest to equal the artifact's, every delete target's current body must still be the body the planner approved (label and URI equal, path recomputed under this publisher), the path must not be in the desired set, and the label must either be retired or fall under `full`. Another publisher's files are never listed and never deleted. Every delete is verified by a 404 readback.

## Kill switch

Disable every production resource cron in Railway. Do not stop the main `jeb` service: it serves replies and holds the same identity.

Then prove quiescence rather than assuming it. Record the disable timestamp. Wait longer than the configured maximum run duration. Query `resource_runs` for production rows started after that timestamp and require zero, then for any row still `running` and require zero. Finally snapshot the tag-prefix listing twice, one full polling interval apart, and require identical path and body hashes. Cron being disabled is not evidence; homeserver and database observation is.

## Rollback

Rollback removes labels through the same reconcile path that wrote them; there is no separate delete tool.

Plan the reconcile first, with the keyless planner:

    railway ssh --service <production-resource-service> -- node dist/main.js --role resources <family-command-and-input> --mode plan --target production --reconcile retired --retired <label> --plan-out /tmp/jeb-rollback-plan.json

Review the artifact, its scope, the counts, the protected set, and the printed hash. Then execute the confirmed plan with the executor, inside the production service with its existing secret reference:

    railway ssh --service <production-resource-service> -- node dist/main.js --role resources <family-command-and-input> --mode reconcile --target production --reconcile retired --retired <label> --expected-pk 9o6xrx8wgqu48dmb47uep6w3dgbwdnf5jgw83gbeuxg9yi7x444y --plan /tmp/jeb-rollback-plan.json --confirm-plan <sha256> --execute

If a PUT succeeded and later verification failed, leave the cron disabled, keep the partial manifest, and rerun the dry reconcile against live state. If a DELETE returned 5xx after PUTs succeeded, do not compensate by deleting the new writes and do not blindly retry: the next confirmed plan determines the remaining work.

## Ledger reset

The spend ledger is operator-retained service data. Neither `resource_spend_day` nor `resource_runs` is owner-scoped identity state, so no identity-clear path wipes them; a schema-enumeration test re-raises that decision if one is ever added.

A stuck reservation — a run killed between reserving and settling — leaves reserved dollars on the current UTC day and can refuse later runs for the rest of that day. Confirm first that no run is actually in flight, using the quiescence procedure above, then reduce the day's `reserved_usd` for that target to zero and leave `actual_usd` untouched. Never reduce `actual_usd`: it is the record of money already spent, and lowering it raises the effective ceiling for the remainder of the day.

A run killed mid-flight stops renewing its lease (15 minutes by default). The next invocation's reaper closes the expired `running` row as `abandoned`; the row is never reused and its reservation is not released automatically. A row still in `running` after a confirmed-quiescent check whose lease has not yet expired can be closed by waiting out the lease, or as `failed` with a failure code; do not delete it, because the run may have written tags and the manifest is the only record of what it did.
