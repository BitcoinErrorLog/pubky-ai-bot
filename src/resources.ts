import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.js";
import { assertNoKeyMaterial } from "./keys.js";
import { discoverCrawlerResources } from "./crawler-resources.js";
import {
  assertStagingResourceConfig,
  discoverResources,
  RESOURCE_INPUT_MAX_BYTES,
  type ExternalResourceInput,
  type ResourceRun,
  validateResourceLimit,
} from "./external-resources.js";
import { openTransport, type Transport } from "./homeserver.js";
import {
  assertPublishableTagLabel,
  publishResourceTags,
  reconcileResourceTags,
  type ReconcilePolicy,
  type ResourcePublishManifest,
  type ResourceReconcilePlan,
} from "./resource-publish.js";
import { RESOURCE_PILOT_BOT_PK } from "./outbound-gate.js";
import { nexusResourceTagInventory, nexusResourceTags, tagResource, type TaggedResource } from "./resource-tagger.js";

function argValue(flag: string, argv: string[]): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("-") ? argv[i + 1] : undefined;
}

function argValues(flag: string, argv: string[]): string[] {
  const values: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === flag && argv[i + 1] && !argv[i + 1].startsWith("-")) values.push(argv[i + 1]!);
  }
  return values;
}

function argvAfterRole(argv: string[]): string[] {
  const roleIdx = argv.indexOf("--role");
  return roleIdx >= 0 ? argv.slice(roleIdx + 2) : argv.slice(2);
}

export function resourceCliMode(argv: string[], fallback: Config["resourceMode"]): Config["resourceMode"] {
  const raw = (argValue("--mode", argv) ?? fallback).trim().toLowerCase();
  if (raw === "shadow" || raw === "publish" || raw === "reconcile") return raw;
  throw new Error("invalid --mode (shadow|publish|reconcile)");
}

export function resourceCliTarget(argv: string[], fallback: Config["resourceTarget"]): Config["resourceTarget"] {
  const raw = (argValue("--target", argv) ?? fallback).trim().toLowerCase();
  if (raw === "staging" || raw === "production") return raw;
  throw new Error("invalid --target (staging|production)");
}

export type ResourcesCliDeps = {
  transport?: Transport;
  openTransport?: typeof openTransport;
};

function taggerMode(argv: string[]): "rules" | "model" {
  const value = (argValue("--tagger", argv) ?? "rules").trim().toLowerCase();
  if (value === "rules" || value === "model") return value;
  throw new Error("invalid --tagger (rules|model)");
}

function fetchEnabled(argv: string[], mode: Config["resourceMode"]): boolean {
  return argv.includes("--fetch") && taggerMode(argv) === "model" && mode === "shadow";
}

const USAGE = [
  "usage: --role resources discover --input <json-file> [--limit <1-100>] [--mode shadow|publish|reconcile] [--target staging]",
  "   or: --role resources crawl --db <sqlite-file> --source <source> --label <taxonomy-label> [--label <taxonomy-label>] [--limit 1-100] [--mode shadow|publish|reconcile] [--target staging] [--fetch]",
];

function reconcilePolicy(argv: string[]): ReconcilePolicy {
  const value = argValue("--reconcile", argv);
  if (value !== "retired" && value !== "full") throw new Error("reconcile mode requires --reconcile retired|full");
  return value;
}

function retiredLabels(argv: string[]): Set<string> {
  const labels = new Set(argValues("--retired", argv));
  for (const label of labels) {
    assertPublishableTagLabel(label);
  }
  return labels;
}

function reconcileLines(plan: ResourceReconcilePlan, hash: string, cfg: { policy: ReconcilePolicy; botPk: string; resolvedHomeserverPk?: string; resourceConfigVersion: string }): string[] {
  const lines = plan.resources.map((r) => JSON.stringify({
    resource_id: r.resource_id, uri: r.uri,
    keep: r.keep, put: r.put, delete: r.delete, protected: r.protected,
  }));
  lines.push(JSON.stringify({ accepted: plan.resources.length, listed: plan.listed, keep: plan.resources.reduce((n, r) => n + r.keep.length, 0), put: plan.put.length, delete: plan.delete.length, protected: plan.resources.reduce((n, r) => n + r.protected.length, 0), policy: cfg.policy, target: "staging", bot_pk: cfg.botPk, resolved_homeserver_pk: cfg.resolvedHomeserverPk, config_version: cfg.resourceConfigVersion, plan_sha256: hash }));
  return lines;
}

async function acquireResourceRunLock(): Promise<() => Promise<void>> {
  const dir = join(process.cwd(), "data");
  const lockPath = join(dir, "resource-publish.lock");
  await mkdir(dir, { recursive: true });
  let handle;
  try {
    handle = await open(lockPath, "wx");
  } catch {
    throw new Error(`resource publish lock exists at ${lockPath}; inspect the operator-owned lock and remove it only after confirming no run is active`);
  }
  await handle.writeFile(JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
  return async () => {
    await handle.close();
    await unlink(lockPath).catch(() => undefined);
  };
}

async function loadDiscoverInput(inputPath: string, limit: number, cfg: Config): Promise<ResourceRun> {
  const fileStat = await stat(inputPath);
  if (!fileStat.isFile()) throw new Error("resource input must be a regular file");
  if (fileStat.size > RESOURCE_INPUT_MAX_BYTES) {
    throw new Error(`resource input file must be no larger than ${RESOURCE_INPUT_MAX_BYTES} bytes`);
  }
  const input = await readFile(inputPath);
  if (input.byteLength > RESOURCE_INPUT_MAX_BYTES) {
    throw new Error(`resource input file must be no larger than ${RESOURCE_INPUT_MAX_BYTES} bytes`);
  }
  const parsed: unknown = JSON.parse(input.toString("utf8"));
  if (!Array.isArray(parsed)) throw new Error("resource input must be a JSON array");
  return discoverResources(parsed as ExternalResourceInput[], {
    category: "pubky",
    limit,
    configVersion: cfg.resourceConfigVersion,
    disabledSources: [...cfg.resourceDisabledSources],
    disabledFamilies: [...cfg.resourceDisabledFamilies],
  });
}

async function maybePublish(
  run: ResourceRun,
  cfg: Config,
  argv: string[],
  deps?: ResourcesCliDeps,
): Promise<{ ok: boolean; payload: ResourceRun & { publish?: ResourcePublishManifest } }> {
  const mode = resourceCliMode(argv, cfg.resourceMode);
  const target = resourceCliTarget(argv, cfg.resourceTarget);
  const effective = { ...cfg, resourceMode: mode, resourceTarget: target };
  assertStagingResourceConfig(effective);
  if (mode === "shadow") {
    return { ok: true, payload: { ...run, mode: "shadow" } };
  }
  const releaseLock = await acquireResourceRunLock();
  // The lock serializes local publishers. Homeserver writes can still race with
  // an external client; fresh reads and PLAN parity remain the residual defense.
  try {
  const transport =
    deps?.transport ??
    (await (deps?.openTransport ?? openTransport)({
      secretKeyHex: cfg.secretKeyHex,
      homeserverPk: cfg.homeserverPk,
      signupToken: cfg.signupToken,
      testnet: cfg.testnet,
    }));
  if (mode === "reconcile") {
    const policy = reconcilePolicy(argv);
    const retired = retiredLabels(argv);
    const expectedPilotPk = argValue("--expected-pk", argv) ?? process.env.JEB_RECONCILE_EXPECTED_PK?.trim() ?? "";
    if (!expectedPilotPk) throw new Error("reconcile requires --expected-pk or JEB_RECONCILE_EXPECTED_PK");
    if (expectedPilotPk !== RESOURCE_PILOT_BOT_PK) throw new Error("reconcile pilot pin constant/flag mismatch");
    const reconciled = await reconcileResourceTags(run.accepted, {
      resourceTarget: target,
      resourceApp: effective.resourceApp,
      resourceConfigVersion: effective.resourceConfigVersion,
      expectedPilotPk,
      policy,
      retired,
      execute: argv.includes("--execute"),
      confirmPlan: argValue("--confirm-plan", argv),
    }, transport);
    return { ok: true, payload: { ...run, mode: "reconcile", publish: { configVersion: effective.resourceConfigVersion, app: effective.resourceApp, target: "staging", written: 0, skipped_existing: 0, failed: 0, writes: [], failures: [], reconcile: reconcileLines(reconciled.plan, reconciled.planSha256, { policy, botPk: transport.botPk, resolvedHomeserverPk: transport.resolvedHomeserverPk, resourceConfigVersion: effective.resourceConfigVersion }) } as ResourcePublishManifest & { reconcile: string[] } } };
  }
  const publish = await publishResourceTags(run.accepted, effective, transport);
  return {
    ok: publish.failed === 0,
    payload: { ...run, mode: "publish", publish },
  };
  } finally {
    await releaseLock?.();
  }
}

async function applyModelTagger(run: ResourceRun, cfg: Config, argv: string[]): Promise<ResourceRun & { tagger: { resources: TaggedResource[]; summary: Record<string, unknown> } }> {
  if (taggerMode(argv) !== "model") return { ...run, tagger: { resources: [], summary: { mode: "rules" } } };
  const useFetch = fetchEnabled(argv, run.mode);
  const resources: TaggedResource[] = [];
  let inventory: string[] = [];
  try {
    inventory = await nexusResourceTagInventory(cfg.nexusUrl, cfg.nexusTimeoutMs);
  } catch {
    inventory = [];
  }
  for (const resource of run.accepted) {
    const tagged = await tagResource(cfg, resource, {
      cacheDir: "/tmp/jeb-pilot-shadow/tagger-cache",
      existingTags: nexusResourceTags(cfg.nexusUrl, cfg.nexusTimeoutMs),
      inventoryTags: inventory,
      fetch: useFetch,
      fetchCacheDir: "/tmp/jeb-pilot-shadow/fetch-cache",
    });
    resources.push(tagged);
    inventory = [...new Set([...inventory, ...tagged.labels])];
  }
  const denials: Record<string, number> = {};
  let cacheHits = 0;
  let modelFailures = 0;
  const histogram: Record<string, number> = {};
  const fetchTotals: Record<string, number> = {};
  let aliasRemaps = 0;
  let siteNameDrops = 0;
  for (const item of resources) {
    if (item.cacheHit) cacheHits += 1;
    if (item.modelFailure) modelFailures += 1;
    countTagger(histogram, String(item.labels.length));
    for (const [reason, amount] of Object.entries(item.denials)) denials[reason] = (denials[reason] ?? 0) + amount;
    if (item.fetch) {
      const key = item.fetch.ok ? "ok" : item.fetch.reason ?? "unknown";
      fetchTotals[key] = (fetchTotals[key] ?? 0) + 1;
    }
    aliasRemaps += Object.keys(item.aliasRemaps ?? {}).length;
    siteNameDrops += item.siteNameDrops?.length ?? 0;
  }
  return {
    ...run,
    tagger: {
      resources,
      summary: {
        mode: "model",
        accepted: resources.length,
        cacheHits,
        modelFailures,
        denialsByReason: denials,
        labelsPerResource: histogram,
        distinctLabels: [...new Set(resources.flatMap((item) => item.labels))].length,
        fetch: { enabled: useFetch, totalsByReason: fetchTotals },
        aliasRemaps,
        siteNameDrops,
      },
    },
  };
}

function countTagger(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

export async function runResourcesCli(
  cfg: Config,
  argv = process.argv,
  deps?: ResourcesCliDeps,
): Promise<{ ok: boolean; lines: string[] }> {
  const mode = resourceCliMode(argv, cfg.resourceMode);
  const target = resourceCliTarget(argv, cfg.resourceTarget);
  const effective = { ...cfg, resourceMode: mode, resourceTarget: target };
  if (mode === "shadow") assertNoKeyMaterial();
  assertStagingResourceConfig(effective);
  const args = argvAfterRole(argv);
  if (args[0] === "crawl") {
    const dbPath = argValue("--db", argv);
    const source = argValue("--source", argv);
    const labels = argValues("--label", argv);
    const limitRaw = argValue("--limit", argv);
    const limit = validateResourceLimit(limitRaw ? Number(limitRaw) : cfg.resourceMaxRecords);
    const result = await discoverCrawlerResources({
      dbPath: dbPath ?? "",
      source: source ?? "",
      labels,
      limit,
    });
    const tagged = await applyModelTagger(result, effective, argv);
    const published = await maybePublish(tagged, effective, argv, deps);
    return { ok: published.ok, lines: [JSON.stringify(published.payload, null, 2)] };
  }
  if (args[0] !== "discover") {
    return { ok: false, lines: USAGE };
  }
  const inputPath = argValue("--input", argv);
  if (!inputPath) return { ok: false, lines: ["discover requires --input <json-file>"] };
  const limitRaw = argValue("--limit", argv);
  const limit = validateResourceLimit(limitRaw ? Number(limitRaw) : cfg.resourceMaxRecords);
  const result = await loadDiscoverInput(inputPath, limit, cfg);
  const tagged = await applyModelTagger(result, effective, argv);
  const published = await maybePublish(tagged, effective, argv, deps);
  return { ok: published.ok, lines: [JSON.stringify(published.payload, null, 2)] };
}
