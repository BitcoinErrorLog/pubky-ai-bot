import type { Transport } from "./homeserver.js";
import { CodedResourceError, resourceErrorCode, type ResourceErrorCode } from "./resource-error-code.js";
import { normalizeUri, resourceIdentity } from "./resource-identity.js";
import {
  asTagBody,
  buildUniversalResourceTag,
  canonicalTagJson,
  gatedResourceTransport,
  readExisting,
  requireReconcileTransport,
  type ResourceTagBody,
} from "./resource-publish.js";
import { listedPathsDigest } from "./resource-planner.js";
import type { PlanArtifactAction, ResourcePlanArtifact } from "./resource-plan-artifact.js";

/**
 * The artifact executor. It performs exactly the actions a confirmed plan
 * names — nothing is rediscovered, refetched, retagged, or replanned — and it
 * reads back every mutation: `verified` is true only when every PUT read back
 * equal and every DELETE read back absent.
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

async function executeDeletes(
  artifact: ResourcePlanArtifact,
  transport: Transport,
  outcome: PlanExecutionOutcome,
): Promise<void> {
  const prefix = `/pub/${artifact.app}/tags/`;
  if (!transport.listJsonPaths) throw new Error("reconcile transport does not support session listing");
  // The listing must still be the listing the operator confirmed.
  const listed = await transport.listJsonPaths(prefix);
  if (listedPathsDigest(listed) !== artifact.listedDigest) {
    throw new CodedResourceError("plan_drift", "homeserver listing changed since the plan was confirmed");
  }
  const { deletes, putsByResource, acceptedUris } = deleteActionMaps(artifact);
  // Every deleted body must still be the body the planner approved.
  const approvedDeletes = new Map<string, ResourceTagBody>();
  for (const action of deletes) {
    const raw = await transport.getJson(action.path);
    const body = asTagBody(raw);
    if (!body) throw new CodedResourceError("homeserver_conflict", "delete target body is malformed");
    if (body.label !== action.label || body.uri !== action.uri) {
      throw new CodedResourceError("plan_drift", "delete target body changed since the plan was confirmed");
    }
    const rebuilt = buildUniversalResourceTag(transport.botPk, artifact.app, body.uri, body.label);
    if (rebuilt.path !== action.path) {
      throw new CodedResourceError("plan_drift", "delete target body no longer derives its listed path");
    }
    approvedDeletes.set(action.path, body);
  }
  const desiredByResource = new Map<string, ReadonlySet<string>>();
  for (const resource of artifact.resources) {
    desiredByResource.set(resource.resourceId, new Set([...resource.keep, ...(putsByResource.get(resource.resourceId) ?? [])]));
  }
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
  for (const action of deletes) {
    await gated.deleteJson(action.path);
    // DELETE readback: the path must be gone, not merely accepted.
    const readback = await readExisting(transport, action.path);
    if (readback !== null) {
      throw new CodedResourceError("readback_failed", `DELETE readback still present at ${action.path}`);
    }
    outcome.deletes += 1;
  }
}

/**
 * Executes the confirmed artifact against the session transport. PUT
 * failures are recorded per item and the batch continues (matching the
 * established publish semantics); any DELETE failure stops the run.
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
  const putClient = gatedResourceTransport(transport, {
    mode: artifact.kind === "reconcile" ? "reconcile" : "publish",
    target: artifact.target,
  });
  await executePuts(artifact, putClient, outcome);
  if (artifact.kind === "reconcile" && outcome.failed === 0) {
    await executeDeletes(artifact, transport, outcome);
  }
  // Verified means every action read back: each PUT equal, each DELETE 404.
  outcome.verified = outcome.failed === 0;
  return outcome;
}
