import { describe, expect, it } from "vitest";
import { discoverResources, type ExternalResource } from "./external-resources.js";
import type { Transport } from "./homeserver.js";
import { RESOURCE_PILOT_BOT_PK, STAGING_HOMESERVER_PK } from "./outbound-gate.js";
import { DEFAULT_RESOURCE_APP, type ResourceTagBody } from "./resource-publish.js";
import { buildPublishPlanArtifact, type PlanIdentityInput } from "./resource-planner.js";
import { assertPlanPutPaths, executePlanArtifact } from "./resource-plan-executor.js";
import type { ResourcePlanArtifact } from "./resource-plan-artifact.js";

const BOT = RESOURCE_PILOT_BOT_PK;

function memoryTransport(
  botPk = BOT,
  resolvedHomeserverPk: string | undefined = STAGING_HOMESERVER_PK,
): Transport & { puts: string[]; store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  const puts: string[] = [];
  return {
    botPk,
    resolvedHomeserverPk,
    puts,
    store,
    async putJson(path, json) {
      puts.push(path);
      store.set(path, json);
    },
    async putBytes() {},
    async getJson(path) {
      if (!store.has(path)) throw new Error("404 Not Found");
      return store.get(path);
    },
    async deleteJson() {},
    async listPosts() {
      return [];
    },
    async reauth() {},
  };
}

function acceptedPair(): ExternalResource[] {
  const run = discoverResources(
    [
      { family: "url", value: "https://example.test/docs", source: "staging-catalog", labels: ["release"] },
      { family: "url", value: "https://example.test/guide", source: "staging-catalog", labels: ["release"] },
    ],
    { limit: 100, configVersion: "test-v1" },
  );
  expect(run.accepted).toHaveLength(2);
  return run.accepted;
}

function identity(): PlanIdentityInput {
  return {
    family: "discover",
    sourceId: "ab".repeat(32),
    tagger: { id: "rules", model: null },
    configVersion: "test-v1",
    sourceHash: "cd".repeat(32),
    gitHead: "ef".repeat(20),
    app: DEFAULT_RESOURCE_APP,
    publisherPk: BOT,
    homeserverPk: STAGING_HOMESERVER_PK,
    limit: 100,
    fetch: false,
    plannedAt: new Date().toISOString(),
  };
}

async function validArtifact(existing: (path: string) => Promise<ResourceTagBody | null> = async () => null): Promise<ResourcePlanArtifact> {
  return buildPublishPlanArtifact(acceptedPair(), identity(), existing);
}

describe("executePlanArtifact under the real gated transport", () => {
  it("executes exactly the artifact actions and verifies them", async () => {
    const client = memoryTransport();
    const artifact = await validArtifact();
    const outcome = await executePlanArtifact(artifact, client);
    expect(outcome.puts).toBe(artifact.actions.length);
    expect(outcome.written).toBe(artifact.actions.length);
    expect(outcome.skipped).toBe(0);
    expect(outcome.failed).toBe(0);
    expect(outcome.verified).toBe(true);
    expect(client.puts).toEqual(artifact.actions.map((action) => action.path));
    for (const action of artifact.actions) {
      expect(client.store.get(action.path)).toEqual(action.body);
    }
    expect(outcome.verifiedPuts).toEqual(artifact.actions.map((action) => ({ uri: action.body.uri, label: action.body.label })));
  });

  it("skips identical existing tags with zero PUTs", async () => {
    const client = memoryTransport();
    const artifact = await validArtifact();
    for (const action of artifact.actions) {
      client.store.set(action.path, { ...action.body, created_at: action.body.created_at - 1000 });
    }
    const outcome = await executePlanArtifact(artifact, client);
    expect(outcome.skipped).toBe(artifact.actions.length);
    expect(outcome.written).toBe(0);
    expect(outcome.failed).toBe(0);
    expect(outcome.verified).toBe(true);
    expect(client.puts).toEqual([]);
  });

  it("stops on a conflicting existing tag with zero further writes", async () => {
    const client = memoryTransport();
    const artifact = await validArtifact();
    const first = artifact.actions[0]!;
    client.store.set(first.path, { uri: first.body.uri, label: "other-label", created_at: first.body.created_at });
    const outcome = await executePlanArtifact(artifact, client);
    expect(outcome.failed).toBe(1);
    expect(outcome.failures[0]).toEqual({ path: first.path, kind: "put", error: "homeserver_conflict" });
    expect(outcome.written).toBe(0);
    expect(outcome.verified).toBe(false);
    // No later mutation: not a single PUT reached the homeserver.
    expect(client.puts).toEqual([]);
  });

  it("fails with readback_failed and stops when the homeserver stores a different body", async () => {
    const client = memoryTransport();
    client.putJson = async (path: string, json: unknown) => {
      client.puts.push(path);
      client.store.set(path, { ...(json as ResourceTagBody), label: "tampered" });
    };
    const artifact = await validArtifact();
    const outcome = await executePlanArtifact(artifact, client);
    expect(outcome.failed).toBe(1);
    expect(outcome.failures[0]!.error).toBe("readback_failed");
    expect(outcome.written).toBe(0);
    expect(outcome.verified).toBe(false);
    expect(client.puts).toEqual([artifact.actions[0]!.path]);
  });

  it("refuses a PUT path that does not derive from its body before any write", async () => {
    const client = memoryTransport();
    const artifact = await validArtifact();
    const drifted: ResourcePlanArtifact = {
      ...artifact,
      actions: artifact.actions.map((action, i) =>
        i === 0 ? { ...action, path: `${action.path}X` } : action,
      ),
    };
    expect(() => assertPlanPutPaths(drifted, BOT)).toThrow("plan PUT path");
    await expect(executePlanArtifact(drifted, client)).rejects.toThrow("plan PUT path");
    expect(client.puts).toEqual([]);
  });

  it("refuses a session publisher that is not the plan's publisher before any write", async () => {
    const client = memoryTransport("8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo");
    const artifact = await validArtifact();
    await expect(executePlanArtifact(artifact, client)).rejects.toThrow("session publisher does not match the plan artifact");
    expect(client.puts).toEqual([]);
  });
});
