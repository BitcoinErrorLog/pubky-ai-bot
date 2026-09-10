import { createHash } from "node:crypto";
import type { ExternalResource } from "./external-resources.js";
import type { Transport } from "./homeserver.js";
import type { ResourceCommandFamily } from "./resource-command-family.js";
import {
  PRODUCTION_PER_RESOURCE_DELETE_RATIO,
  buildUniversalResourceTag,
  makePublishPlan,
  makeReconcilePlan,
  productionFullDeleteCeiling,
  productionFullDeleteViolations,
  type DeleteOverrides,
  type ReconcilePolicy,
} from "./resource-publish.js";
import {
  PLAN_ARTIFACT_KIND,
  PLAN_ARTIFACT_VERSION,
  type PlanArtifactAction,
  type PlanArtifactResource,
  type ResourcePlanArtifact,
} from "./resource-plan-artifact.js";
import type { ResourceTargetProfile } from "./resource-target-profile.js";

/**
 * The keyless planner. It turns a discovered, tagged resource run into the
 * single immutable artifact the executor will later commit to. It never sees
 * a bot key: publish paths derive from the pinned publisher public key, and a
 * reconcile listing comes from unauthenticated public reads.
 */
export interface PlanIdentityInput {
  kind: "publish" | "reconcile";
  family: ResourceCommandFamily;
  sourceId: string;
  tagger: { id: "rules" | "model"; model: string | null };
  configVersion: string;
  distHash: string;
  profile: ResourceTargetProfile;
  app: string;
  limit: number;
  fetch: boolean;
  policy: ReconcilePolicy | null;
  retired: ReadonlySet<string>;
  overrides: DeleteOverrides;
  runId: string | null;
  reservedUsd: number | null;
  firstProductionWrite: boolean;
  plannedAt?: string;
}

function baseArtifact(identity: PlanIdentityInput): Omit<ResourcePlanArtifact, "listed" | "listedDigest" | "ceilings" | "resources" | "actions"> {
  return {
    artifact: PLAN_ARTIFACT_KIND,
    version: PLAN_ARTIFACT_VERSION,
    kind: identity.kind,
    family: identity.family,
    sourceId: identity.sourceId,
    tagger: identity.tagger,
    configVersion: identity.configVersion,
    pinSetVersion: identity.profile.pinSetVersion,
    distHash: identity.distHash,
    target: identity.profile.target,
    app: identity.app,
    publisherPk: identity.profile.publisherPk,
    homeserverPk: identity.profile.homeserverPk,
    limit: identity.limit,
    fetch: identity.fetch,
    policy: identity.policy,
    retired: [...identity.retired].sort(),
    allowMassDelete: identity.overrides.allowMassDelete,
    allowHighDeleteRatio: identity.overrides.allowHighDeleteRatio,
    runId: identity.runId,
    reservedUsd: identity.reservedUsd,
    firstProductionWrite: identity.firstProductionWrite,
    plannedAt: identity.plannedAt ?? new Date().toISOString(),
  };
}

function sortActions(actions: PlanArtifactAction[]): PlanArtifactAction[] {
  return actions.sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind));
}

/** Publish plan: one PUT action per desired tag, with the full tag-file body. */
export function buildPublishPlanArtifact(
  accepted: readonly ExternalResource[],
  identity: PlanIdentityInput,
): ResourcePlanArtifact {
  const plan = makePublishPlan(accepted, identity.profile.publisherPk, identity.app);
  const actions: PlanArtifactAction[] = plan.items.map((item) => {
    const built = buildUniversalResourceTag(identity.profile.publisherPk, identity.app, item.normalizedUri, item.label);
    return { kind: "put", path: built.path, body: built.body };
  });
  const byResource = new Map<string, PlanArtifactResource>();
  for (const item of plan.items) {
    let row = byResource.get(item.resourceIdentity);
    if (!row) {
      byResource.set(item.resourceIdentity, (row = { resourceId: item.resourceIdentity, keep: [], protected: [], puts: 0, deletes: 0 }));
    }
    row.puts += 1;
  }
  return {
    ...baseArtifact(identity),
    kind: "publish",
    policy: null,
    listed: null,
    listedDigest: null,
    ceilings: {
      deleteCeiling: null,
      perResourceDeleteRatio: PRODUCTION_PER_RESOURCE_DELETE_RATIO,
      puts: actions.length,
      deletes: 0,
      violations: [],
    },
    resources: [...byResource.values()].sort((a, b) => a.resourceId.localeCompare(b.resourceId)),
    actions: sortActions(actions),
  };
}

/**
 * Reconcile plan from a live listing. A violating production `full` plan is
 * never written: the refusal happens here, before the artifact exists.
 */
export async function buildReconcilePlanArtifact(
  accepted: readonly ExternalResource[],
  identity: PlanIdentityInput,
  client: Transport,
): Promise<ResourcePlanArtifact> {
  if (!identity.policy) throw new Error("reconcile planning requires a policy");
  const { plan, listedPaths } = await makeReconcilePlan(accepted, {
    resourceTarget: identity.profile.target,
    resourceApp: identity.app,
    resourceConfigVersion: identity.configVersion,
    expectedPublisherPk: identity.profile.publisherPk,
    policy: identity.policy,
    retired: identity.retired,
    execute: false,
  }, client);
  const actions: PlanArtifactAction[] = [
    ...plan.put.map((action) => {
      if (!action.body) throw new Error("reconcile put action is missing its body");
      return { kind: "put" as const, path: action.path, body: action.body };
    }),
    ...plan.delete.map((action) => {
      if (!action.body) throw new Error("reconcile delete action is missing its body");
      return { kind: "delete" as const, path: action.path, label: action.label, uri: action.body.uri };
    }),
  ];
  const violations =
    identity.profile.target === "production" && identity.policy === "full"
      ? productionFullDeleteViolations(plan, identity.overrides)
      : [];
  if (violations.length > 0) {
    throw new Error(`production full reconcile refused: ${violations.map((v) => v.kind).join(", ")}`);
  }
  const resources: PlanArtifactResource[] = plan.resources
    .map((resource) => ({
      resourceId: resource.resource_id,
      keep: resource.keep.map((action) => action.label).sort(),
      protected: resource.protected.map((action) => action.label).sort(),
      puts: resource.put.length,
      deletes: resource.delete.length,
    }))
    .sort((a, b) => a.resourceId.localeCompare(b.resourceId));
  const listed = [...listedPaths].sort();
  return {
    ...baseArtifact(identity),
    kind: "reconcile",
    listed: plan.listed,
    listedDigest: createHash("sha256").update(JSON.stringify(listed)).digest("hex"),
    ceilings: {
      deleteCeiling:
        identity.profile.target === "production" && identity.policy === "full"
          ? productionFullDeleteCeiling(plan.listed)
          : null,
      perResourceDeleteRatio: PRODUCTION_PER_RESOURCE_DELETE_RATIO,
      puts: actions.filter((action) => action.kind === "put").length,
      deletes: actions.filter((action) => action.kind === "delete").length,
      violations: [],
    },
    resources,
    actions: sortActions(actions),
  };
}

/** Digest of a listing, recomputed by the executor before any delete. */
export function listedPathsDigest(paths: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify([...paths].sort())).digest("hex");
}
