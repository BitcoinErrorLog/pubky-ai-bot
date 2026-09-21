import type { Transport } from "./homeserver.js";
import { CodedResourceError, resourceErrorCode, type ResourceErrorCode } from "./resource-error-code.js";
import {
  buildUniversalResourceTag,
  gatedResourceTransport,
  readExisting,
} from "./resource-publish.js";
import type { ResourcePlanArtifact } from "./resource-plan-artifact.js";

/**
 * The artifact executor. It performs exactly the actions a confirmed plan
 * names — nothing is rediscovered, refetched, retagged, or replanned — and it
 * reads back every mutation: `verified` is true only when every PUT read
 * back with the same uri and label.
 */
export interface PlanExecutionOutcome {
  puts: number;
  written: number;
  skipped: number;
  verifiedPuts: Array<{ uri: string; label: string }>;
  failed: number;
  failures: Array<{ path: string; kind: "put"; error: ResourceErrorCode }>;
  verified: boolean;
}

function planDrift(message: string): CodedResourceError {
  return new CodedResourceError("plan_drift", message);
}

/**
 * Every PUT path is recomputed from its body before the first write, exactly
 * as the planner derived it (app id + tag id from uri/label under this
 * publisher), and must sit under the app's tag prefix. A crafted or drifted
 * action refuses the whole batch with zero writes.
 */
export function assertPlanPutPaths(artifact: ResourcePlanArtifact, botPk: string): void {
  const prefix = `/pub/${artifact.app}/tags/`;
  for (const action of artifact.actions) {
    if (!action.path.startsWith(prefix)) {
      throw planDrift("plan PUT path is outside the plan's app tag prefix");
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
 * Executes the confirmed artifact against the session transport. PUT paths
 * are re-derived before the first write; the session publisher must be the
 * plan's pinned publisher; the first failed action stops the batch with no
 * later mutation. `verified` is true only when every action read back equal.
 */
export async function executePlanArtifact(
  artifact: ResourcePlanArtifact,
  transport: Transport,
): Promise<PlanExecutionOutcome> {
  const outcome: PlanExecutionOutcome = {
    puts: artifact.actions.length,
    written: 0,
    skipped: 0,
    verifiedPuts: [],
    failed: 0,
    failures: [],
    verified: false,
  };
  assertPlanPutPaths(artifact, transport.botPk);
  if (transport.botPk !== artifact.publisherPk) {
    throw new CodedResourceError("config_refused", "session publisher does not match the plan artifact");
  }
  const putClient = gatedResourceTransport(transport);
  for (const action of artifact.actions) {
    try {
      const existing = await readExisting(transport, action.path);
      // created_at is not part of tag identity: same uri + same label is a skip.
      if (existing && existing.uri === action.body.uri && existing.label === action.body.label) {
        outcome.skipped += 1;
        outcome.verifiedPuts.push({ uri: action.body.uri, label: action.body.label });
        continue;
      }
      if (existing) {
        throw new CodedResourceError("homeserver_conflict", "tag path already holds a different uri/label");
      }
      await putClient.putJson(action.path, action.body);
      const readback = await readExisting(transport, action.path);
      if (!readback || readback.uri !== action.body.uri || readback.label !== action.body.label) {
        throw new CodedResourceError("readback_failed", `PUT readback mismatch at ${action.path}`);
      }
      outcome.written += 1;
      outcome.verifiedPuts.push({ uri: action.body.uri, label: action.body.label });
    } catch (error) {
      outcome.failed += 1;
      outcome.failures.push({
        path: action.path,
        kind: "put",
        error: resourceErrorCode(error, "homeserver_conflict"),
      });
      // First failure stops the batch: no later mutation.
      break;
    }
  }
  outcome.verified = outcome.failed === 0;
  return outcome;
}
