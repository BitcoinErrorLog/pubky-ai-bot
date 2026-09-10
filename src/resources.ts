import { mkdir, open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { Config } from "./config.js";
import { assertNoKeyMaterial } from "./keys.js";
import { discoverCrawlerResources } from "./crawler-resources.js";
import { BITCOIN_CANON_SOURCE_ID, discoverBitcoinCanon, toResourceInputs } from "./resource-canon.js";
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
import { nexusResourceHasTagger, nexusResourceTagInventory, nexusResourceTags, tagResource, type TaggedResource } from "./resource-tagger.js";
import { RESOURCE_CONFIG_VERSION } from "./resource-taxonomy.js";
import { sourceTreeHash } from "./source-tree-hash.js";
import { discoverPubkyPosts } from "./resource-posts.js";
import { discoverPubkyLinks } from "./resource-links.js";
import { Nexus } from "./nexus.js";
import { createPublicHomeserverReader } from "./pubchi/homeserver-read.js";
import { discoverBtcMapPlaces } from "./resource-places.js";

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
  buildStampPath?: string;
  gitHead?: string;
};

type ResourceBuildStamp = { configVersion: string; gitHead: string; sourceHash: string };

function currentGitHead(): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function assertResourceBuildStamp(
  mode: Config["resourceMode"],
  options: { stampPath?: string; gitHead?: string; sourceRoot?: string } = {},
): Promise<void> {
  const stampPath = options.stampPath ?? join(process.cwd(), "dist/build-stamp.json");
  let rawStamp: unknown;
  try {
    rawStamp = JSON.parse(await readFile(stampPath, "utf8")) as unknown;
  } catch {
    const message = `resource ${mode} refused: missing build stamp at ${stampPath}; run npm run build`;
    if (mode === "shadow") {
      console.warn(`${message} (shadow continues)`);
      return;
    }
    throw new Error(message);
  }
  if (
    rawStamp === null ||
    typeof rawStamp !== "object" ||
    Array.isArray(rawStamp) ||
    typeof (rawStamp as Partial<ResourceBuildStamp>).configVersion !== "string" ||
    typeof (rawStamp as Partial<ResourceBuildStamp>).gitHead !== "string" ||
    typeof (rawStamp as Partial<ResourceBuildStamp>).sourceHash !== "string"
  ) {
    throw new Error(`resource ${mode} refused: malformed build stamp at ${stampPath}; run npm run build`);
  }
  const stamp = rawStamp as ResourceBuildStamp;
  const gitHead = options.gitHead ?? currentGitHead();
  const sourceHash = await sourceTreeHash(options.sourceRoot);
  const mismatch = stamp.configVersion !== RESOURCE_CONFIG_VERSION
    ? `config version ${stamp.configVersion} does not match running ${RESOURCE_CONFIG_VERSION}`
    : gitHead && stamp.gitHead !== gitHead
      ? `git head ${stamp.gitHead} does not match current ${gitHead}`
      : stamp.sourceHash !== sourceHash
        ? `source hash ${stamp.sourceHash} does not match current ${sourceHash}`
      : undefined;
  if (!mismatch) return;
  const gitNote = gitHead ? "" : " (.git unavailable; skipped git check)";
  const message = `resource ${mode} refused: stale build stamp: ${mismatch}${gitNote}`;
  if (mode === "shadow") {
    console.warn(`${message} (shadow continues)`);
    return;
  }
  throw new Error(message);
}

function taggerMode(argv: string[]): "rules" | "model" {
  const value = (argValue("--tagger", argv) ?? "rules").trim().toLowerCase();
  if (value === "rules" || value === "model") return value;
  throw new Error("invalid --tagger (rules|model)");
}

function fetchEnabled(argv: string[], mode: Config["resourceMode"]): boolean {
  return argv.includes("--fetch") && taggerMode(argv) === "model";
}

const USAGE = [
  "usage: --role resources discover --input <json-file> [--limit <1-100>] [--mode shadow|publish|reconcile] [--target staging]",
  "   or: --role resources crawl --db <sqlite-file> --source <source> --label <taxonomy-label> [--label <taxonomy-label>] [--limit 1-100] [--mode shadow|publish|reconcile] [--target staging] [--fetch]",
  "   or: --role resources --source pubky-posts [--limit 1-100] [--mode shadow|publish] [--tagger model] [--fetch]",
  "   or: --role resources --source pubky-links [--limit 1-100] [--mode shadow|publish] [--tagger model] [--fetch]",
  "   or: --role resources places [--limit 1-100] [--mode shadow|publish|reconcile] [--target staging]",
  "   or: --role resources canon --source bitcoin-canon [--limit 1-100] [--mode shadow|publish|reconcile] [--target staging] [--tagger rules|model] [--fetch]",
];

function reconcilePolicy(argv: string[]): ReconcilePolicy {
  const value = argValue("--reconcile", argv);
  if (value !== "retired" && value !== "full") throw new Error("reconcile mode requires --reconcile retired|full");
  return value;
}

async function writeP2Labels(run: ResourceRun & { tagger?: { resources: TaggedResource[] } }, mode: "rules" | "model"): Promise<string> {
  const directory = "/tmp/jeb-p2";
  const path = join(directory, "LABELS-P2.md");
  await mkdir(directory, { recursive: true });
  const tagged = new Map((run.tagger?.resources ?? []).map((item) => [item.url, item.labels]));
  const lines = [
    "# P2 Pubky links",
    `Tagger mode: ${mode}`,
    "",
    "| Canonical URL | Sharing post URI(s) | Labels | Score components |",
    "| --- | --- | --- | --- |",
  ];
  for (const resource of run.accepted) {
    const sharingPosts = (run as ResourceRun & { bySharingPost?: Record<string, string[]> }).bySharingPost?.[resource.canonicalValue] ?? [];
    lines.push(`| [${resource.canonicalValue}](${resource.canonicalValue}) | ${sharingPosts.join("<br>")} | ${(tagged.get(resource.canonicalValue) ?? resource.labels).join(", ")} | ${JSON.stringify(resource.provenance.scoreComponents ?? {})} |`);
  }
  await writeFile(path, `${lines.join("\n")}\n`, "utf8");
  return path;
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
  const halt = (run as ResourceRun & { tagger?: { summary?: { halt?: { reason: string } | null } } }).tagger?.summary?.halt;
  if (halt?.reason.split(",").includes("model-failure-rate")) {
    throw new Error(`resource publish/reconcile refused: ${halt.reason}`);
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
  if (cfg.resourceInventoryHint === "on") {
    try {
      inventory = await nexusResourceTagInventory(cfg.nexusUrl, cfg.nexusTimeoutMs);
    } catch {
      inventory = [];
    }
  }
  let tokens = 0;
  let estimatedTokens = 0;
  let estimatedUsd = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let usageEstimated = false;
  for (const resource of run.accepted) {
    const tagged = await tagResource(cfg, resource, {
      cacheDir: join(cfg.resourceCacheDir, "tagger"),
      ...(cfg.resourceInventoryHint === "on"
        ? { existingTags: nexusResourceTags(cfg.nexusUrl, cfg.nexusTimeoutMs) }
        : {}),
      inventoryHint: cfg.resourceInventoryHint,
      inventoryTags: inventory,
      fetch: useFetch,
      fetchCacheDir: join(cfg.resourceCacheDir, "fetch"),
      fetchTtlDays: cfg.resourceFetchTtlDays,
    });
    if (tagged.usage) {
      tokens += tagged.usage.tokens;
      tokensIn += tagged.usage.tokensIn;
      tokensOut += tagged.usage.tokensOut;
      usageEstimated ||= tagged.usage.usage_estimated;
      if (tagged.usage.estimated) estimatedTokens += tagged.usage.tokens;
      estimatedUsd += tagged.usage.usd;
    }
    const tokenCap = Math.min(cfg.resourceRunTokenCap, cfg.dailyTokenBudget);
    if (tokens > tokenCap || estimatedUsd > cfg.resourceRunUsdCap) {
      throw new Error(`resource tagger budget exceeded: tokens=${tokens}/${tokenCap} usd=${estimatedUsd.toFixed(6)}/${cfg.resourceRunUsdCap}`);
    }
    Object.assign(resource, {
      labels: tagged.labels,
      authors: resource.authors,
      provenance: {
        ...resource.provenance,
        labelProvenance: tagged.provenance,
        taggedAt: new Date().toISOString(),
      },
    });
    resources.push(tagged);
    inventory = [...new Set([...inventory, ...tagged.labels])];
  }
  const denials: Record<string, number> = Object.create(null);
  let cacheHits = 0;
  let modelFailures = 0;
  const histogram: Record<string, number> = Object.create(null);
  const fetchTotals: Record<string, number> = Object.create(null);
  let aliasRemaps = 0;
  let siteNameDrops = 0;
  const labelCounts: Record<string, number> = Object.create(null);
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
    for (const label of item.labels) labelCounts[label] = (labelCounts[label] ?? 0) + 1;
  }
  const totalLabels = resources.reduce((n, item) => n + item.labels.length, 0);
  const distinctLabels = Object.keys(labelCounts).length;
  const singletonRate = distinctLabels ? Object.values(labelCounts).filter((n) => n === 1).length / distinctLabels : 0;
  const nearDuplicatePairs = Object.keys(labelCounts).flatMap((a, i, labels) =>
    labels.slice(i + 1).filter((b) => a.replace(/[-s]/g, "") === b.replace(/[-s]/g, "") || a.startsWith(`${b}-`) || b.startsWith(`${a}-`)),
  ).length;
  const nearDuplicateRate = distinctLabels ? nearDuplicatePairs / distinctLabels : 0;
  const modelFailureRate = resources.length ? modelFailures / resources.length : 0;
  const metrics = {
    distinctTotalRatio: totalLabels ? distinctLabels / totalLabels : 0,
    singletonRate,
    nearDuplicatePairs,
    nearDuplicateRate,
    labelsPerResource: histogram,
    labelResourceHistogram: labelCounts,
    modelFailureRate,
  };
  const haltReasons: string[] = [];
  if (modelFailureRate > cfg.resourceModelFailHalt) haltReasons.push("model-failure-rate");
  if (resources.length >= 200 && (metrics.distinctTotalRatio > cfg.resourceDistinctRatioMax || metrics.distinctTotalRatio < cfg.resourceDistinctRatioMin)) haltReasons.push("distinct-total-ratio");
  if (resources.length >= 500 && singletonRate > cfg.resourceSingletonRateHalt) haltReasons.push("singleton-rate");
  if (nearDuplicateRate > cfg.resourceNearDuplicateRateHalt) haltReasons.push("near-duplicate-rate");
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
        distinctLabels,
        fetch: { enabled: useFetch, totalsByReason: fetchTotals },
        aliasRemaps,
        siteNameDrops,
        metering: { tokens, tokensIn, tokensOut, estimatedTokens, usage_estimated: usageEstimated, estimatedUsd, dailyTokenBudget: cfg.dailyTokenBudget, tokenCap: Math.min(cfg.resourceRunTokenCap, cfg.dailyTokenBudget), usdCap: cfg.resourceRunUsdCap },
        metrics,
        halt: haltReasons.length ? { reason: haltReasons.join(",") } : null,
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
  await assertResourceBuildStamp(mode, { stampPath: deps?.buildStampPath, gitHead: deps?.gitHead });
  if (mode === "shadow") assertNoKeyMaterial();
  assertStagingResourceConfig(effective);
  const args = argvAfterRole(argv);
  if (argValue("--source", argv) === "pubky-posts") {
    const limitRaw = argValue("--limit", argv);
    const limit = validateResourceLimit(limitRaw ? Number(limitRaw) : cfg.resourceMaxRecords);
    const nexus = new Nexus(cfg.nexusUrl, cfg.nexusTimeoutMs);
    const result = await discoverPubkyPosts({
      nexus,
      limit,
      fetchLinks: true,
      publisherPk: cfg.botPk,
      publicReader: createPublicHomeserverReader({ testnet: cfg.testnet, timeoutMs: cfg.nexusTimeoutMs }),
      authorCreatedAtMs: async (author) => {
        const profile = await nexus.user(author).catch(() => null);
        if (!profile || typeof profile !== "object") return null;
        const value = profile as { indexed_at?: unknown; created_at?: unknown };
        const timestamp = value.indexed_at ?? value.created_at;
        return typeof timestamp === "number" ? timestamp : typeof timestamp === "string" ? Date.parse(timestamp) : null;
      },
    });
    const tagged = await applyModelTagger(result, effective, argv);
    const published = await maybePublish(tagged, effective, argv, deps);
    return { ok: published.ok, lines: [JSON.stringify(published.payload, null, 2)] };
  }
  if (argValue("--source", argv) === "pubky-links") {
    const limitRaw = argValue("--limit", argv);
    const limit = validateResourceLimit(limitRaw ? Number(limitRaw) : cfg.resourceMaxRecords);
    const nexus = new Nexus(cfg.nexusUrl, cfg.nexusTimeoutMs);
    const result = await discoverPubkyLinks({
      nexus,
      limit,
      publisherPk: cfg.botPk,
      publicReader: createPublicHomeserverReader({ testnet: cfg.testnet, timeoutMs: cfg.nexusTimeoutMs }),
      authorCreatedAtMs: async (author) => {
        const profile = await nexus.user(author).catch(() => null);
        if (!profile || typeof profile !== "object") return null;
        const value = profile as { indexed_at?: unknown; created_at?: unknown };
        const timestamp = value.indexed_at ?? value.created_at;
        return typeof timestamp === "number" ? timestamp : typeof timestamp === "string" ? Date.parse(timestamp) : null;
      },
      configVersion: cfg.resourceConfigVersion,
      alreadyJebTagged: nexusResourceHasTagger(cfg.nexusUrl, cfg.nexusTimeoutMs, cfg.botPk ?? ""),
    });
    const tagged = await applyModelTagger(result, effective, argv);
    const published = await maybePublish(tagged, effective, argv, deps);
    const payload = { ...published.payload, links: { bySharingPost: result.bySharingPost, linkHostHistogram: result.linkHostHistogram, linkRejections: result.linkRejections, postRejections: result.postRejections } };
    if (mode === "shadow") {
      (payload as Record<string, unknown>).labelsPath = await writeP2Labels(tagged, taggerMode(argv));
    }
    return { ok: published.ok, lines: [JSON.stringify(payload, null, 2)] };
  }
  if (args[0] === "places") {
    const limitRaw = argValue("--limit", argv);
    const limit = validateResourceLimit(limitRaw ? Number(limitRaw) : cfg.resourceMaxRecords);
    const result = await discoverBtcMapPlaces({
      limit,
      configVersion: cfg.resourceConfigVersion,
      cacheDir: cfg.resourceCacheDir,
    });
    const tagged = await applyModelTagger(result, effective, argv);
    const published = await maybePublish(tagged, effective, argv, deps);
    return { ok: published.ok, lines: [JSON.stringify(published.payload, null, 2)] };
  }
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
  if (args[0] === "canon") {
    if ((argValue("--source", argv) ?? BITCOIN_CANON_SOURCE_ID) !== BITCOIN_CANON_SOURCE_ID) {
      return { ok: false, lines: ["canon requires --source bitcoin-canon"] };
    }
    const limitRaw = argValue("--limit", argv);
    const limit = validateResourceLimit(limitRaw ? Number(limitRaw) : cfg.resourceMaxRecords);
    const candidates = await discoverBitcoinCanon({ limit, includeWithdrawn: argv.includes("--include-withdrawn") });
    const result = discoverResources(toResourceInputs(candidates), {
      category: "pubky",
      limit,
      configVersion: cfg.resourceConfigVersion,
      disabledSources: [...cfg.resourceDisabledSources],
      disabledFamilies: [...cfg.resourceDisabledFamilies],
    });
    const tagged = await applyModelTagger(result, effective, argv);
    const published = await maybePublish(tagged, effective, argv, deps);
    return { ok: published.ok, lines: [JSON.stringify({ ...published.payload, canon: { candidates: candidates.length } }, null, 2)] };
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
