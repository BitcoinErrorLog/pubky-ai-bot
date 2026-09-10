import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { assertResourceTargetGate, type Config } from "./config.js";
import { assertNoKeyMaterial } from "./keys.js";
import { discoverCrawlerResources } from "./crawler-resources.js";
import { discoverBitcoinCanon, toResourceInputs } from "./resource-canon.js";
import {
  assertResourceRunConfig,
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
import { RESOURCE_CONFIG_VERSION } from "./resource-taxonomy.js";
import { distArtifactHash } from "./dist-artifact-hash.js";
import { resolveResourceCommandFamily, type ResourceCommandFamily } from "./resource-command-family.js";
import {
  assertProfileCoversApp,
  RESOURCE_PIN_SET_VERSION,
  resourceTargetProfile,
  type ResourceTarget,
  type ResourceTargetProfile,
} from "./resource-target-profile.js";
import { discoverPubkyPosts } from "./resource-posts.js";
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
  distRoot?: string;
  gitHead?: string;
};

/**
 * The stamp binds the release identity of the running artifact: signed-off
 * config version, commit, and the hash of the deployed `dist` tree. It
 * deliberately carries no target — one immutable image serves both staging
 * and production, and the run's target is validated at runtime against the
 * compiled profile set plus the two-value environment gate.
 */
type ResourceBuildStamp = { configVersion: string; gitHead: string; distHash: string; pinSetVersion: string };

/** Bounded mismatch classes; never a path, env value, or thrown object. */
export type BuildStampMismatch = "config_version" | "git_head" | "dist_hash" | "pin_set_version";

function currentGitHead(): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function assertResourceBuildStamp(
  mode: Config["resourceMode"],
  options: { stampPath?: string; gitHead?: string; distRoot?: string } = {},
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
    typeof (rawStamp as Partial<ResourceBuildStamp>).distHash !== "string" ||
    typeof (rawStamp as Partial<ResourceBuildStamp>).pinSetVersion !== "string"
  ) {
    throw new Error(`resource ${mode} refused: malformed build stamp at ${stampPath}; run npm run build`);
  }
  const stamp = rawStamp as ResourceBuildStamp;
  const gitHead = options.gitHead ?? currentGitHead();
  // The stamp is written into `dist`, so its own directory is the deployed
  // artifact root. Callers never name a second path that could drift.
  const distRoot = options.distRoot ?? dirname(stampPath);
  const distHash = await distArtifactHash(distRoot);
  const mismatch: BuildStampMismatch | undefined = stamp.configVersion !== RESOURCE_CONFIG_VERSION
    ? "config_version"
    : stamp.pinSetVersion !== RESOURCE_PIN_SET_VERSION
      ? "pin_set_version"
      : gitHead && stamp.gitHead !== gitHead
        ? "git_head"
        : stamp.distHash !== distHash
          ? "dist_hash"
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
  "usage: --role resources discover --input <json-file> [--limit <1-100>] [--mode shadow|publish|reconcile] [--target staging|production]",
  "   or: --role resources crawl --db <sqlite-file> --source <source> --label <taxonomy-label> [--label <taxonomy-label>] [--limit 1-100] [--mode shadow|publish|reconcile] [--target staging|production] [--fetch]",
  "   or: --role resources --source pubky-posts [--limit 1-100] [--mode shadow|publish] [--tagger model] [--fetch]",
  "   or: --role resources places [--limit 1-100] [--mode shadow|publish|reconcile] [--target staging|production]",
  "   or: --role resources canon --source bitcoin-canon [--limit 1-100] [--mode shadow|publish|reconcile] [--target staging|production] [--tagger rules|model] [--fetch]",
  "exactly one family per run. publish and reconcile also require --expected-pk <publisher>.",
  "publish is a dry run until --execute; the first production write needs --confirm-plan <sha256>.",
  "reconcile: --reconcile retired|full [--retired <label> ...] [--execute] [--confirm-plan <sha256>]",
  "production full reconcile over its delete ceilings also needs --allow-mass-delete and/or --allow-high-delete-ratio.",
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

/**
 * `--expected-pk` is mandatory for every mutating mode and must equal the
 * publisher the target pins; there is no silent fallback.
 */
function expectedPublisher(argv: string[], profile: ResourceTargetProfile): string {
  const value = argValue("--expected-pk", argv) ?? process.env.JEB_RECONCILE_EXPECTED_PK?.trim() ?? "";
  if (!value) throw new Error("publish/reconcile requires --expected-pk or JEB_RECONCILE_EXPECTED_PK");
  if (value !== profile.publisherPk) throw new Error("publisher pin constant/flag mismatch");
  return value;
}

function reconcileLines(plan: ResourceReconcilePlan, hash: string, cfg: { policy: ReconcilePolicy; target: ResourceTarget; botPk: string; resolvedHomeserverPk?: string; resourceConfigVersion: string }): string[] {
  const lines = plan.resources.map((r) => JSON.stringify({
    resource_id: r.resource_id, uri: r.uri,
    keep: r.keep, put: r.put, delete: r.delete, protected: r.protected,
  }));
  lines.push(JSON.stringify({ accepted: plan.resources.length, listed: plan.listed, keep: plan.resources.reduce((n, r) => n + r.keep.length, 0), put: plan.put.length, delete: plan.delete.length, protected: plan.resources.reduce((n, r) => n + r.protected.length, 0), policy: cfg.policy, target: cfg.target, bot_pk: cfg.botPk, resolved_homeserver_pk: cfg.resolvedHomeserverPk, config_version: cfg.resourceConfigVersion, plan_sha256: hash }));
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
  const profile = resourceTargetProfile(target);
  const effective = { ...cfg, resourceMode: mode, resourceTarget: target };
  // A `--target production` flag cannot authorize production on its own.
  assertResourceTargetGate(target);
  assertResourceRunConfig(effective);
  assertProfileCoversApp(profile, effective.resourceApp);
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
  const expectedPublisherPk = expectedPublisher(argv, profile);
  if (mode === "reconcile") {
    const policy = reconcilePolicy(argv);
    const retired = retiredLabels(argv);
    const reconciled = await reconcileResourceTags(run.accepted, {
      resourceTarget: target,
      resourceApp: effective.resourceApp,
      resourceConfigVersion: effective.resourceConfigVersion,
      expectedPublisherPk,
      policy,
      retired,
      execute: argv.includes("--execute"),
      confirmPlan: argValue("--confirm-plan", argv),
      allowMassDelete: argv.includes("--allow-mass-delete"),
      allowHighDeleteRatio: argv.includes("--allow-high-delete-ratio"),
    }, transport);
    const manifest: ResourcePublishManifest & { reconcile: string[] } = {
      configVersion: effective.resourceConfigVersion,
      app: effective.resourceApp,
      target,
      executed: argv.includes("--execute"),
      plan: { items: [], rejected: [] },
      planSha256: reconciled.planSha256,
      written: 0,
      skipped_existing: 0,
      failed: 0,
      writes: [],
      failures: [],
      reconcile: reconcileLines(reconciled.plan, reconciled.planSha256, {
        policy,
        target,
        botPk: transport.botPk,
        resolvedHomeserverPk: transport.resolvedHomeserverPk,
        resourceConfigVersion: effective.resourceConfigVersion,
      }),
    };
    return { ok: true, payload: { ...run, mode: "reconcile", publish: manifest } };
  }
  const publish = await publishResourceTags(run.accepted, {
    ...effective,
    expectedPublisherPk,
    execute: argv.includes("--execute"),
    confirmPlan: argValue("--confirm-plan", argv),
  }, transport);
  return {
    ok: publish.failed === 0,
    payload: { ...run, mode: "publish", publish },
  };
  } finally {
    await releaseLock?.();
  }
}

async function applyModelTagger(
  run: ResourceRun,
  cfg: Config,
  argv: string[],
  profile: ResourceTargetProfile,
): Promise<ResourceRun & { tagger: { resources: TaggedResource[]; summary: Record<string, unknown> } }> {
  if (taggerMode(argv) !== "model") return { ...run, tagger: { resources: [], summary: { mode: "rules" } } };
  const useFetch = fetchEnabled(argv, run.mode);
  const resources: TaggedResource[] = [];
  let inventory: string[] = [];
  if (cfg.resourceInventoryHint === "on") {
    try {
      inventory = await nexusResourceTagInventory(profile.nexusUrl, cfg.nexusTimeoutMs);
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
        ? { existingTags: nexusResourceTags(profile.nexusUrl, cfg.nexusTimeoutMs) }
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
  // Exactly one family, resolved before the build stamp, Postgres, the model,
  // Nexus, and any key access. Dispatch used to give `--source pubky-posts`
  // silent priority over a positional command.
  let family: ResourceCommandFamily;
  try {
    family = resolveResourceCommandFamily(argvAfterRole(argv));
  } catch (error) {
    return { ok: false, lines: [error instanceof Error ? error.message : String(error), ...USAGE] };
  }
  const profile = resourceTargetProfile(target);
  // URLs and public keys come only from the compiled profile: JEB_NEXUS_URL and
  // JEB_HOMESERVER have no authority over a resource run.
  const effective = {
    ...cfg,
    resourceMode: mode,
    resourceTarget: target,
    nexusUrl: profile.nexusUrl,
  };
  // A `--target production` flag cannot authorize production on its own; the
  // service environment has to carry the two-value gate.
  assertResourceTargetGate(target);
  await assertResourceBuildStamp(mode, {
    stampPath: deps?.buildStampPath,
    distRoot: deps?.distRoot,
    gitHead: deps?.gitHead,
  });
  if (mode === "shadow") assertNoKeyMaterial();
  assertResourceRunConfig(effective);
  assertProfileCoversApp(profile, effective.resourceApp);
  const limitRaw = argValue("--limit", argv);
  const limit = validateResourceLimit(limitRaw ? Number(limitRaw) : cfg.resourceMaxRecords);
  if (family === "pubky-posts") {
    const nexus = new Nexus(profile.nexusUrl, cfg.nexusTimeoutMs);
    const result = await discoverPubkyPosts({
      nexus,
      limit,
      fetchLinks: true,
      publisherPk: cfg.botPk,
      publicReader: createPublicHomeserverReader({ testnet: cfg.testnet, timeoutMs: cfg.nexusTimeoutMs }),
      authorCreatedAtMs: async (author) => {
        const authorProfile = await nexus.user(author).catch(() => null);
        if (!authorProfile || typeof authorProfile !== "object") return null;
        const value = authorProfile as { indexed_at?: unknown; created_at?: unknown };
        const timestamp = value.indexed_at ?? value.created_at;
        return typeof timestamp === "number" ? timestamp : typeof timestamp === "string" ? Date.parse(timestamp) : null;
      },
    });
    const tagged = await applyModelTagger(result, effective, argv, profile);
    const published = await maybePublish(tagged, effective, argv, deps);
    return { ok: published.ok, lines: [JSON.stringify(published.payload, null, 2)] };
  }
  if (family === "places") {
    const result = await discoverBtcMapPlaces({
      limit,
      configVersion: cfg.resourceConfigVersion,
      cacheDir: cfg.resourceCacheDir,
    });
    const tagged = await applyModelTagger(result, effective, argv, profile);
    const published = await maybePublish(tagged, effective, argv, deps);
    return { ok: published.ok, lines: [JSON.stringify(published.payload, null, 2)] };
  }
  if (family === "crawl") {
    const result = await discoverCrawlerResources({
      dbPath: argValue("--db", argv) ?? "",
      source: argValue("--source", argv) ?? "",
      labels: argValues("--label", argv),
      limit,
    });
    const tagged = await applyModelTagger(result, effective, argv, profile);
    const published = await maybePublish(tagged, effective, argv, deps);
    return { ok: published.ok, lines: [JSON.stringify(published.payload, null, 2)] };
  }
  if (family === "canon") {
    const candidates = await discoverBitcoinCanon({ limit, includeWithdrawn: argv.includes("--include-withdrawn") });
    const result = discoverResources(toResourceInputs(candidates), {
      category: "pubky",
      limit,
      configVersion: cfg.resourceConfigVersion,
      disabledSources: [...cfg.resourceDisabledSources],
      disabledFamilies: [...cfg.resourceDisabledFamilies],
    });
    const tagged = await applyModelTagger(result, effective, argv, profile);
    const published = await maybePublish(tagged, effective, argv, deps);
    return { ok: published.ok, lines: [JSON.stringify({ ...published.payload, canon: { candidates: candidates.length } }, null, 2)] };
  }
  const result = await loadDiscoverInput(argValue("--input", argv) ?? "", limit, cfg);
  const tagged = await applyModelTagger(result, effective, argv, profile);
  const published = await maybePublish(tagged, effective, argv, deps);
  return { ok: published.ok, lines: [JSON.stringify(published.payload, null, 2)] };
}
