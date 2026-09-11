import type { Transport } from "./homeserver.js";
import { CodedResourceError, resourceErrorCode, type ResourceErrorCode } from "./resource-error-code.js";
import { normalizeUri, resourceIdentity } from "./resource-identity.js";
import {
  PRODUCTION_PER_RESOURCE_DELETE_RATIO,
  asTagBody,
  assertDeletedFromHomeserver,
  buildUniversalResourceTag,
  canonicalTagJson,
  gatedResourceTransport,
  productionFullDeleteCeiling,
  readExisting,
  requireReconcileTransport,
  type ResourceTagBody,
} from "./resource-publish.js";
import { listedPathsDigest } from "./resource-planner.js";
import type { PlanArtifactAction, ResourcePlanArtifact } from "./resource-plan-artifact.js";
import { resourceTargetProfile } from "./resource-target-profile.js";

/**
 * The artifact executor. It performs exactly the actions a confirmed plan
 * names — nothing is rediscovered, refetched, retagged, or replanned — and it
 * reads back every mutation: `verified` is true only when every PUT read back
 * equal and every DELETE read back a literal 404.
 */
export interface PlanExecutionOutcome {
  puts: number;
  written: number;
  skipped: number;
  deletes: number;
  failed: number;
  failures: Array<{ path: string; kind: string; error: ResourceErrorCode }>;
  verified: boolean;
}

function planDrift(message: string): CodedResourceError {
  return new CodedResourceError("plan_drift", message);
}

/**
 * Every PUT path is recomputed from its body before the first write, exactly
 * as the planner derived it (app id + tag id from uri/label under this
 * publisher), and must sit under the pinned tag prefix of the target's
 * compiled profile — never a prefix taken from the artifact. A crafted or
 * drifted action refuses the whole batch with zero writes.
 */
export function assertPlanPutPaths(artifact: ResourcePlanArtifact, botPk: string): void {
  const prefix = resourceTargetProfile(artifact.target).tagCapabilityScope;
  for (const action of artifact.actions) {
    if (action.kind !== "put") continue;
    if (!action.path.startsWith(prefix)) {
      throw planDrift("plan PUT path is outside the pinned tag prefix for this target");
    }
    let rebuilt: { path: string };
    try {
      rebuilt = buildUniversalResourceTag(botPk, artifact.app, action.body.uri, action.body.label);
    } catch {
      throw planDrift("plan PUT body cannot rederive a tag path");
    }
    if (rebuilt.path !== action.path) {
      throw planDrift("plan PUT path does not derive from its body");
    }
  }
}

/**
 * PUT failures stop the batch: the first failed predicate means no later
 * mutation (design §8 failure ordering). The failure is recorded with its
 * bounded code so the run row carries the real cause.
 */
async function executePuts(
  artifact: ResourcePlanArtifact,
  client: Transport,
  outcome: PlanExecutionOutcome,
): Promise<void> {
  for (const action of artifact.actions) {
    if (action.kind !== "put") continue;
    try {
      const existing = await readExisting(client, action.path);
      if (existing && canonicalTagJson(existing) === canonicalTagJson(action.body)) {
        outcome.skipped += 1;
        continue;
      }
      if (existing) throw new Error("tag path already holds a different uri/label");
      await client.putJson(action.path, action.body);
      const readback = await readExisting(client, action.path);
      if (!readback || canonicalTagJson(readback) !== canonicalTagJson(action.body)) {
        throw new CodedResourceError("readback_failed", `PUT readback mismatch at ${action.path}`);
      }
      outcome.written += 1;
    } catch (error) {
      outcome.failed += 1;
      outcome.failures.push({
        path: action.path,
        kind: "put",
        error: resourceErrorCode(error, "homeserver_conflict"),
      });
      return;
    }
  }
}

function deleteActionMaps(artifact: ResourcePlanArtifact): {
  deletes: Array<PlanArtifactAction & { kind: "delete" }>;
  putsByResource: Map<string, Set<string>>;
  acceptedUris: Map<string, string>;
} {
  const deletes: Array<PlanArtifactAction & { kind: "delete" }> = [];
  const putsByResource = new Map<string, Set<string>>();
  const acceptedUris = new Map<string, string>();
  for (const action of artifact.actions) {
    const uri = action.kind === "put" ? action.body.uri : action.uri;
    const label = action.kind === "put" ? action.body.label : action.label;
    const id = resourceIdentity(normalizeUri(uri));
    acceptedUris.set(id, normalizeUri(uri));
    if (action.kind === "delete") {
      deletes.push(action);
    } else {
      let labels = putsByResource.get(id);
      if (!labels) putsByResource.set(id, (labels = new Set()));
      labels.add(label);
    }
  }
  return { deletes, putsByResource, acceptedUris };
}

function identityOf(uri: string, message: string): string {
  try {
    return resourceIdentity(normalizeUri(uri));
  } catch {
    throw planDrift(message);
  }
}

/**
 * Delete ceilings re-evaluated from the LIVE listing and the artifact's
 * actions — never from the artifact's self-attested counts: the run ceiling
 * min(50, floor(20% of live listed)), the 50%-per-resource ratio against
 * live existing labels, and the unbypassable empty-desired-set guard against
 * live keep sets plus planned puts.
 */
function assertLiveDeleteCeilings(
  artifact: ResourcePlanArtifact,
  live: {
    listed: number;
    deletes: Array<PlanArtifactAction & { kind: "delete" }>;
    deletesByResource: Map<string, number>;
    existingByResource: Map<string, number>;
    desiredByResource: Map<string, ReadonlySet<string>>;
  },
): void {
  if (artifact.kind !== "reconcile" || artifact.target !== "production" || artifact.policy !== "full") return;
  const violations = new Set<string>();
  if (live.deletes.length > productionFullDeleteCeiling(live.listed) && !artifact.allowMassDelete) {
    violations.add("run_ceiling");
  }
  for (const [id, count] of live.deletesByResource) {
    if ((live.desiredByResource.get(id)?.size ?? 0) === 0) violations.add("empty_desired_set");
    const existing = live.existingByResource.get(id) ?? 0;
    if (existing > 0 && count > PRODUCTION_PER_RESOURCE_DELETE_RATIO * existing && !artifact.allowHighDeleteRatio) {
      violations.add("per_resource_ratio");
    }
  }
  if (violations.size > 0) {
    throw planDrift(`production full reconcile refused at execution: ${[...violations].sort().join(", ")}`);
  }
}

type PreparedReconcileState = {
  listed: string[];
  deletes: Array<PlanArtifactAction & { kind: "delete" }>;
  approvedDeletes: Map<string, ResourceTagBody>;
  acceptedUris: Map<string, string>;
  desiredByResource: Map<string, Set<string>>;
  gated: Transport;
};

async function prepareReconcileState(artifact: ResourcePlanArtifact, transport: Transport): Promise<PreparedReconcileState> {
  // The pinned prefix comes from the compiled target profile, not the artifact.
  const prefix = resourceTargetProfile(artifact.target).tagCapabilityScope;
  if (!transport.listJsonPaths) throw new Error("reconcile transport does not support session listing");
  // The listing must still be the listing the operator confirmed.
  const listed = await transport.listJsonPaths(prefix);
  if (listedPathsDigest(listed) !== artifact.listedDigest) {
    throw new CodedResourceError("plan_drift", "homeserver listing changed since the plan was confirmed");
  }
  // Every listed body is re-read: keep/protected/existing sets and the delete
  // ceilings are derived from this live state, not from the artifact.
  const liveBodies = new Map<string, ResourceTagBody>();
  for (const path of listed) {
    const body = asTagBody(await transport.getJson(path));
    if (!body) throw new CodedResourceError("homeserver_conflict", "listed tag body is malformed");
    liveBodies.set(path, body);
  }
  const { deletes, putsByResource, acceptedUris } = deleteActionMaps(artifact);
  // Every deleted body must still be the body the planner approved.
  const approvedDeletes = new Map<string, ResourceTagBody>();
  const deletedPaths = new Set<string>();
  const deletesByResource = new Map<string, number>();
  for (const action of deletes) {
    const body = liveBodies.get(action.path);
    if (!body) throw planDrift("delete target is no longer listed");
    if (body.label !== action.label || body.uri !== action.uri) {
      throw planDrift("delete target body changed since the plan was confirmed");
    }
    let rebuilt: { path: string };
    try {
      rebuilt = buildUniversalResourceTag(transport.botPk, artifact.app, body.uri, body.label);
    } catch {
      throw planDrift("delete target body no longer derives its listed path");
    }
    if (rebuilt.path !== action.path) {
      throw planDrift("delete target body no longer derives its listed path");
    }
    approvedDeletes.set(action.path, body);
    deletedPaths.add(action.path);
    const id = identityOf(body.uri, "delete target body no longer derives an identity");
    deletesByResource.set(id, (deletesByResource.get(id) ?? 0) + 1);
  }
  // Desired labels per resource, recomputed live: kept bodies (live, not
  // deleted) plus the labels the plan puts. The artifact's keep/protected
  // sets are informational; they never authorize a delete here.
  const desiredByResource = new Map<string, Set<string>>();
  const existingByResource = new Map<string, number>();
  for (const [path, body] of liveBodies) {
    const id = identityOf(body.uri, "listed tag body no longer derives an identity");
    existingByResource.set(id, (existingByResource.get(id) ?? 0) + 1);
    if (deletedPaths.has(path)) continue;
    let labels = desiredByResource.get(id);
    if (!labels) desiredByResource.set(id, (labels = new Set()));
    labels.add(body.label);
  }
  for (const [id, putLabels] of putsByResource) {
    let labels = desiredByResource.get(id);
    if (!labels) desiredByResource.set(id, (labels = new Set()));
    for (const label of putLabels) labels.add(label);
  }
  assertLiveDeleteCeilings(artifact, { listed: listed.length, deletes, deletesByResource, existingByResource, desiredByResource });
  const gated = requireReconcileTransport(transport, {
    mode: "reconcile",
    target: artifact.target,
    app: artifact.app,
    expectedPublisherPk: artifact.publisherPk,
    listedPaths: new Set(listed),
    approvedDeletes,
    acceptedUris,
    desiredByResource,
    retiredLabels: new Set(artifact.retired),
    policy: artifact.policy ?? "retired",
  });
  return { listed, deletes, approvedDeletes, acceptedUris, desiredByResource, gated };
}

async function executeDeletes(
  prepared: PreparedReconcileState,
  outcome: PlanExecutionOutcome,
): Promise<void> {
  const { deletes, gated } = prepared;
  for (const action of deletes) {
    await gated.deleteJson(action.path);
    // DELETE readback: only a literal 404 proves absence.
    await assertDeletedFromHomeserver(gated, action.path);
    outcome.deletes += 1;
  }
}

/**
 * Executes the confirmed artifact against the session transport. PUT paths
 * are re-derived and pinned before the first write; the first PUT failure
 * stops the batch; any DELETE failure stops the run. `verified` is true only
 * when every action read back: each PUT equal, each DELETE a literal 404.
 */
export async function executePlanArtifact(
  artifact: ResourcePlanArtifact,
  transport: Transport,
): Promise<PlanExecutionOutcome> {
  const outcome: PlanExecutionOutcome = {
    puts: artifact.actions.filter((action) => action.kind === "put").length,
    written: 0,
    skipped: 0,
    deletes: 0,
    failed: 0,
    failures: [],
    verified: false,
  };
  assertPlanPutPaths(artifact, transport.botPk);
  const putClient = gatedResourceTransport(transport, {
    mode: artifact.kind === "reconcile" ? "reconcile" : "publish",
    target: artifact.target,
  });
  const prepared = artifact.kind === "reconcile" ? await prepareReconcileState(artifact, transport) : undefined;
  await executePuts(artifact, putClient, outcome);
  if (artifact.kind === "reconcile" && outcome.failed === 0) {
    await executeDeletes(prepared!, outcome);
  }
  // Verified means every action read back: each PUT equal, each DELETE 404.
  outcome.verified = outcome.failed === 0;
  return outcome;
}
