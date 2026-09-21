import type { ExternalResource } from "./external-resources.js";
import { RESOURCE_RECORD_MAX } from "./external-resources.js";
import { createPublicHomeserverReader } from "./pubchi/homeserver-read.js";
import type { ResourceCommandFamily } from "./resource-command-family.js";
import { normalizeUri, resourceIdentity } from "./resource-identity.js";
import {
  RESOURCE_WRITE_MAX,
  asTagBody,
  assertResourceTargetAllowed,
  buildUniversalResourceTag,
  type ResourceTagBody,
} from "./resource-publish.js";
import {
  PLAN_ARTIFACT_KIND,
  PLAN_ARTIFACT_VERSION,
  type PlanArtifactAction,
  type PlanArtifactResource,
  type ResourcePlanArtifact,
} from "./resource-plan-artifact.js";

/**
 * The keyless planner. It turns a discovered, tagged resource run into the
 * single immutable artifact the executor will later commit to. It never sees
 * a bot key: publish paths derive from the pinned publisher public key, and
 * existing-state reads are unauthenticated public reads.
 */
export interface PlanIdentityInput {
  family: ResourceCommandFamily;
  sourceId: string;
  tagger: { id: "rules" | "model"; model: string | null };
  configVersion: string;
  sourceHash: string;
  gitHead: string;
  app: string;
  publisherPk: string;
  homeserverPk: string;
  limit: number;
  fetch: boolean;
  plannedAt?: string;
}

/** Reads the current tag body at a homeserver path; null means absent. */
export type ExistingTagReader = (path: string) => Promise<ResourceTagBody | null>;

/**
 * Unauthenticated existing-state reader over the public homeserver API: it
 * resolves `pubky://<publisherPk><path>` with no session, maps a literal 404
 * to null, and refuses a 200 whose body is not a well-formed tag.
 */
export function publicTagReader(opts: { publisherPk: string; testnet: boolean; timeoutMs: number }): ExistingTagReader {
  const reader = createPublicHomeserverReader({ testnet: opts.testnet, timeoutMs: opts.timeoutMs });
  return async (path: string) => {
    const result = await reader.getJson(`pubky://${opts.publisherPk}${path}`);
    if (result.status === 404) return null;
    const body = asTagBody(result.body);
    if (!body) throw new Error("public tag read returned a malformed tag body");
    return body;
  };
}

/**
 * Publish plan: one PUT action per desired tag not already on the homeserver,
 * keep entries for the ones that are. A path already holding a DIFFERENT
 * uri/label refuses the whole plan — the planner never overwrites a tag it
 * did not derive, and the executor never re-plans.
 */
export async function buildPublishPlanArtifact(
  accepted: readonly ExternalResource[],
  identity: PlanIdentityInput,
  existing: ExistingTagReader,
): Promise<ResourcePlanArtifact> {
  const byResource = new Map<string, PlanArtifactResource>();
  const actions: PlanArtifactAction[] = [];
  for (const resource of accepted) {
    const normalized = normalizeUri(resource.canonicalValue);
    const id = resourceIdentity(normalized);
    if (resource.identity !== id) throw new Error(`accepted resource identity mismatch for ${normalized}`);
    assertResourceTargetAllowed(resource, normalized);
    if (byResource.has(id)) throw new Error("duplicate accepted resource identity");
    const row: PlanArtifactResource = { resourceId: id, uri: normalized, keep: [], puts: 0 };
    byResource.set(id, row);
    if (byResource.size > RESOURCE_RECORD_MAX) {
      throw new Error(`resource plan would cover ${byResource.size} resources; max is ${RESOURCE_RECORD_MAX}`);
    }
    for (const label of resource.labels) {
      const built = buildUniversalResourceTag(identity.publisherPk, identity.app, normalized, label);
      let prior: ResourceTagBody | null;
      try {
        prior = await existing(built.path);
      } catch (error) {
        throw new Error(`existing-state read failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (prior === null) {
        actions.push({ kind: "put", path: built.path, body: built.body });
        row.puts += 1;
        if (actions.length > RESOURCE_WRITE_MAX) {
          throw new Error(`resource plan would issue ${actions.length} writes; max is ${RESOURCE_WRITE_MAX}`);
        }
        continue;
      }
      // created_at is not part of tag identity: same uri + same label is a keep.
      if (prior.uri === built.body.uri && prior.label === built.body.label) {
        row.keep.push(label);
        continue;
      }
      throw new Error("tag path already holds a different uri/label");
    }
    row.keep.sort();
  }
  return {
    artifact: PLAN_ARTIFACT_KIND,
    version: PLAN_ARTIFACT_VERSION,
    kind: "publish",
    family: identity.family,
    sourceId: identity.sourceId,
    tagger: identity.tagger,
    configVersion: identity.configVersion,
    sourceHash: identity.sourceHash,
    gitHead: identity.gitHead,
    target: "staging",
    app: identity.app,
    publisherPk: identity.publisherPk,
    homeserverPk: identity.homeserverPk,
    limit: identity.limit,
    fetch: identity.fetch,
    plannedAt: identity.plannedAt ?? new Date().toISOString(),
    resources: [...byResource.values()].sort((a, b) => a.resourceId.localeCompare(b.resourceId)),
    actions: actions.sort((a, b) => a.path.localeCompare(b.path)),
  };
}
