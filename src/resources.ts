import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import pg from "pg";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { assertResourceTargetGate, type Config } from "./config.js";
import { assertNoKeyMaterial, secretFromEnv } from "./keys.js";
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
import { CodedResourceError } from "./resource-error-code.js";
import {
  assertPublishableTagLabel,
  type ReconcilePolicy,
} from "./resource-publish.js";
import { nexusResourceTagInventory, nexusResourceTags, tagResource, type TaggedResource } from "./resource-tagger.js";
import { RESOURCE_CONFIG_VERSION } from "./resource-taxonomy.js";
import { distArtifactHash } from "./dist-artifact-hash.js";
import { resolveResourceCommandFamily, type ResourceCommandFamily } from "./resource-command-family.js";
import { ResourceRunSession } from "./resource-run-session.js";
import { openProductionScopedTransport } from "./resource-scoped-session.js";
import { assertExecutorEnvContract, assertExecutorForbiddenEnv, assertPlannerEnvContract } from "./resource-env-contract.js";
import {
  assertPlanArtifactFresh,
  assertPlanArtifactLive,
  assertArtifactDeleteCeilings,
  readPlanArtifact,
  writePlanArtifact,
  type LoadedPlanArtifact,
  type PlanLiveIdentity,
} from "./resource-plan-artifact.js";
import { buildPublishPlanArtifact, buildReconcilePlanArtifact, type PlanIdentityInput } from "./resource-planner.js";
import { executePlanArtifact } from "./resource-plan-executor.js";
import { publicTagReadTransport } from "./resource-public-read.js";
import { verifyNexusIndexed, type NexusVerifyResult } from "./resource-nexus-verify.js";
import {
  assertProfileCoversApp,
  RESOURCE_PIN_SET_VERSION,
  resourceTargetProfile,
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

function requiredPositiveIntegerFlag(flag: string, argv: string[], fallback: number): number {
  const flagIndex = argv.findIndex((arg) => arg === flag || arg.startsWith(`${flag}=`));
  if (flagIndex < 0) return validateResourceLimit(fallback);
  const argument = argv[flagIndex]!;
  const raw = argument === flag ? argv[flagIndex + 1] : argument.slice(flag.length + 1);
  if (raw === undefined || !/^(?:[1-9]\d?|100)$/.test(raw)) {
    throw new Error(`${flag} requires exactly one integer from 1 to 100`);
  }
  return validateResourceLimit(Number(raw));
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
  if (raw === "shadow" || raw === "plan" || raw === "publish" || raw === "reconcile") return raw;
  throw new Error("invalid --mode (shadow|plan|publish|reconcile)");
}

export function resourceCliTarget(argv: string[], fallback: Config["resourceTarget"]): Config["resourceTarget"] {
  const raw = (argValue("--target", argv) ?? fallback).trim().toLowerCase();
  if (raw === "staging" || raw === "production") return raw;
  throw new Error("invalid --target (staging|production)");
}

export type ResourcesCliDeps = {
  transport?: Transport;
  pool?: pg.Pool;
  openTransport?: typeof openTransport;
  buildStampPath?: string;
  distRoot?: string;
  gitHead?: string;
  /** Test seams proving the executor never discovers, fetches, or tags. */
  onDiscovery?: (family: ResourceCommandFamily) => void;
  onTagger?: () => void;
  tagResource?: typeof tagResource;
  nexusVerify?: typeof verifyNexusIndexed;
  publicRead?: {
    list?: (address: string, cursor: string | null, limit: number) => Promise<string[]>;
    getJson?: (uri: string) => Promise<unknown>;
  };
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
  "usage: --role resources discover --input <json-file> [--limit <1-100>] [--mode shadow|plan] [--target staging|production]",
  "   or: --role resources crawl --db <sqlite-file> --source <source> --label <taxonomy-label> [--label <taxonomy-label>] [--limit 1-100] [--mode shadow|plan] [--target staging|production] [--fetch]",
  "   or: --role resources --source pubky-posts [--limit 1-100] [--mode shadow|plan] [--tagger model] [--fetch]",
  "   or: --role resources places [--limit 1-100] [--mode shadow|plan] [--target staging|production]",
  "   or: --role resources canon --source bitcoin-canon [--limit 1-100] [--mode shadow|plan] [--target staging|production] [--tagger rules|model] [--fetch]",
  "exactly one family per run. publishing is two steps with two processes:",
  "  1. planner (keyless):  --mode plan --plan-out <file> [--reconcile retired|full [--retired <label> ...]]",
  "  2. executor (key-bearing): --mode publish|reconcile --plan <file> --confirm-plan <sha256> --execute --expected-pk <publisher>",
  "publish/reconcile without --execute loads and verifies the plan and prints what would run.",
  "production full reconcile over its delete ceilings also needs --allow-mass-delete and/or --allow-high-delete-ratio in both steps.",
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
  const value = argValue("--expected-pk", argv) ?? "";
  if (!value) throw new Error("publish/reconcile requires --expected-pk");
  if (value !== profile.publisherPk) throw new Error("publisher pin constant/flag mismatch");
  return value;
}

export async function acquireResourceRunLock(): Promise<() => Promise<void>> {
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

async function loadDiscoverInput(inputPath: string, limit: number, cfg: Config): Promise<{ run: ResourceRun; sourceId: string }> {
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
  const run = discoverResources(parsed as ExternalResourceInput[], {
    category: "pubky",
    limit,
    configVersion: cfg.resourceConfigVersion,
    disabledSources: [...cfg.resourceDisabledSources],
    disabledFamilies: [...cfg.resourceDisabledFamilies],
  });
  return { run, sourceId: `discover:${createHash("sha256").update(input).digest("hex")}` };
}

/** The deployed-artifact hash both the stamp check and the plan artifact bind. */
async function currentDistHash(deps?: ResourcesCliDeps): Promise<string> {
  return distArtifactHash(deps?.distRoot ?? dirname(deps?.buildStampPath ?? join(process.cwd(), "dist/build-stamp.json")));
}

/**
 * Production invocations always run under a ledger session. Staging keeps its
 * current Postgres-free behaviour unless a pool is injected, so the pilot
 * workflow is unchanged. The reservation commits before any model, Nexus, or
 * fetch call, so a run that cannot pay never spends.
 */
async function openRunSession(
  effective: Config,
  profile: ResourceTargetProfile,
  family: ResourceCommandFamily,
  limit: number,
  deps?: ResourcesCliDeps,
  consumePlan?: { planSha256: string; plannerRunId: string; plannedAt: string },
): Promise<ResourceRunSession | undefined> {
  if (profile.target !== "production" && !deps?.pool) return undefined;
  return ResourceRunSession.open(
    {
      profile,
      family,
      publisherPk: profile.publisherPk,
      distHash: await currentDistHash(deps),
      limit,
      caps: { runUsdCap: effective.resourceRunUsdCap, dailyUsdCap: effective.resourceDailyUsdCap },
      databaseUrl: effective.databaseUrl,
      perResourceEstimateUsd: profile.perResourceEstimateUsd,
      consumePlan,
    },
    { pool: deps?.pool },
  );
}

interface DiscoveredRun {
  run: ResourceRun;
  sourceId: string;
  canon?: { candidates: number };
}

/** Discovery only. The executor path never calls this. */
async function discoverFamilyRun(
  family: ResourceCommandFamily,
  cfg: Config,
  effective: Config,
  argv: string[],
  limit: number,
  profile: ResourceTargetProfile,
  deps?: ResourcesCliDeps,
): Promise<DiscoveredRun> {
  deps?.onDiscovery?.(family);
  if (family === "pubky-posts") {
    const nexus = new Nexus(profile.nexusUrl, cfg.nexusTimeoutMs);
    const run = await discoverPubkyPosts({
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
    return { run, sourceId: "pubky-posts" };
  }
  if (family === "places") {
    const run = await discoverBtcMapPlaces({
      limit,
      configVersion: cfg.resourceConfigVersion,
      cacheDir: cfg.resourceCacheDir,
    });
    return { run, sourceId: "btcmap-places" };
  }
  if (family === "crawl") {
    const run = await discoverCrawlerResources({
      dbPath: argValue("--db", argv) ?? "",
      source: argValue("--source", argv) ?? "",
      labels: argValues("--label", argv),
      limit,
    });
    return { run, sourceId: `crawl:${argValue("--source", argv) ?? ""}` };
  }
  if (family === "canon") {
    const candidates = await discoverBitcoinCanon({ limit, includeWithdrawn: argv.includes("--include-withdrawn") });
    const run = discoverResources(toResourceInputs(candidates), {
      category: "pubky",
      limit,
      configVersion: cfg.resourceConfigVersion,
      disabledSources: [...cfg.resourceDisabledSources],
      disabledFamilies: [...cfg.resourceDisabledFamilies],
    });
    return { run, sourceId: "bitcoin-canon", canon: { candidates: candidates.length } };
  }
  const { run, sourceId } = await loadDiscoverInput(argValue("--input", argv) ?? "", limit, effective);
  return { run, sourceId };
}

type TaggedRun = ResourceRun & { tagger: { resources: TaggedResource[]; summary: Record<string, unknown> } };

function assertNoModelHalt(run: TaggedRun): void {
  const halt = (run.tagger.summary as { halt?: { reason: string } | null }).halt;
  if (halt?.reason.split(",").includes("model-failure-rate")) {
    throw new Error(`resource plan refused: ${halt.reason}`);
  }
}

async function applyModelTagger(
  run: ResourceRun,
  cfg: Config,
  argv: string[],
  profile: ResourceTargetProfile,
  session?: ResourceRunSession,
  deps?: ResourcesCliDeps,
): Promise<TaggedRun> {
  if (taggerMode(argv) !== "model") return { ...run, tagger: { resources: [], summary: { mode: "rules" } } };
  deps?.onTagger?.();
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
    const tagged = await (deps?.tagResource ?? tagResource)(cfg, resource, {
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
    if (session) {
      // Every model call and every cache hit is metered under the reservation
      // made before discovery, and each step's cumulative actual is persisted
      // with the lease renewal: spend never lives only in process memory. A
      // missing or unmeasurable usage record refuses the run rather than
      // letting spend go uncounted.
      if (tagged.modelFailure) {
        await session.recordSpend({ cached: false, usd: undefined as unknown as number });
      } else if (tagged.cacheHit) {
        await session.recordSpend({ cached: true });
      } else {
        await session.recordSpend({ cached: false, usd: tagged.usage?.usd as number });
      }
    }
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

function taggerIdentity(cfg: Config, argv: string[]): { id: "rules" | "model"; model: string | null } {
  const id = taggerMode(argv);
  return { id, model: id === "model" ? cfg.model : null };
}

/** The keyless planner: discover, tag under the spend ledger, write one canonical artifact. */
async function runPlanner(
  cfg: Config,
  effective: Config,
  profile: ResourceTargetProfile,
  family: ResourceCommandFamily,
  argv: string[],
  limit: number,
  deps?: ResourcesCliDeps,
): Promise<{ ok: boolean; lines: string[] }> {
  const planOut = argValue("--plan-out", argv);
  if (!planOut) throw new Error("--mode plan requires --plan-out <path>");
  const kind = argv.includes("--reconcile") ? ("reconcile" as const) : ("publish" as const);
  const policy = kind === "reconcile" ? reconcilePolicy(argv) : null;
  const retired = kind === "reconcile" ? retiredLabels(argv) : new Set<string>();
  const releaseLock = await acquireResourceRunLock();
  let session: ResourceRunSession | undefined;
  try {
    // The reservation commits here, before any model, Nexus, or fetch call.
    session = await openRunSession(effective, profile, family, limit, deps);
    const discovered = await discoverFamilyRun(family, cfg, effective, argv, limit, profile, deps);
    const tagged = await applyModelTagger(discovered.run, effective, argv, profile, session, deps);
    assertNoModelHalt(tagged);
    const identity: PlanIdentityInput = {
      kind,
      family,
      sourceId: discovered.sourceId,
      tagger: taggerIdentity(cfg, argv),
      configVersion: effective.resourceConfigVersion,
      distHash: await currentDistHash(deps),
      profile,
      app: effective.resourceApp,
      limit,
      fetch: fetchEnabled(argv, "plan"),
      policy,
      retired,
      overrides: {
        allowMassDelete: argv.includes("--allow-mass-delete"),
        allowHighDeleteRatio: argv.includes("--allow-high-delete-ratio"),
      },
      runId: session?.runId ?? null,
      reservedUsd: session?.reservation?.reservedUsd ?? null,
      // The planner run row's DB timestamp: freshness is enforced between two
      // database clock values, never between two process wall clocks.
      plannedAt: session?.startedAt?.toISOString(),
      // Read from the ledger, never from a flag: a plan that claims
      // first-write status the database contradicts is a refusal at execute.
      firstProductionWrite: session ? await session.firstProductionWritePending() : false,
    };
    const artifact =
      kind === "reconcile"
        ? await buildReconcilePlanArtifact(
            tagged.accepted,
            identity,
            deps?.transport ??
              publicTagReadTransport({ publisherPk: profile.publisherPk, testnet: cfg.testnet, ...deps?.publicRead }),
          )
        : buildPublishPlanArtifact(tagged.accepted, identity);
    const planSha256 = await writePlanArtifact(planOut, artifact);
    await session?.finish({
      status: "succeeded",
      accepted: tagged.accepted.length,
      processed: tagged.accepted.length,
      unprocessed: 0,
      written: 0,
      skipped: 0,
      failed: 0,
      // The planner performs no operations; planned counts live in the
      // artifact under plan_sha256. Recording them here would corrupt the
      // ledger-derived first-production-write state.
      puts: 0,
      deletes: 0,
      verified: false,
      planSha256,
    });
    const summary = {
      mode: "plan",
      kind,
      plan_sha256: planSha256,
      plan_out: planOut,
      family,
      target: profile.target,
      puts: artifact.ceilings.puts,
      deletes: artifact.ceilings.deletes,
      listed: artifact.listed,
      resources: artifact.resources.length,
      run_id: artifact.runId,
      first_production_write: artifact.firstProductionWrite,
      ...(discovered.canon ? { canon: discovered.canon } : {}),
    };
    return { ok: true, lines: [JSON.stringify(summary, null, 2)] };
  } catch (error) {
    await session?.fail(error);
    throw error;
  } finally {
    await releaseLock();
  }
}

function executorSummary(loaded: LoadedPlanArtifact, extra: Record<string, unknown>): string {
  return JSON.stringify(
    {
      mode: loaded.artifact.kind,
      plan_sha256: loaded.sha256,
      family: loaded.artifact.family,
      target: loaded.artifact.target,
      puts: loaded.artifact.ceilings.puts,
      deletes: loaded.artifact.ceilings.deletes,
      listed: loaded.artifact.listed,
      ...extra,
    },
    null,
    2,
  );
}

/**
 * The key-bearing executor. It performs no discovery, no fetch, and no
 * tagging: it loads the planner's immutable artifact, re-verifies its hash
 * and every identity field against the live process, binds and consumes the
 * plan hash against its planner row (a confirmed plan executes at most
 * once), enforces freshness between the two run rows' database timestamps,
 * and only then executes exactly those actions — with PUT paths re-derived
 * from their bodies and pinned to the target profile's tag prefix, and the
 * delete ceilings re-evaluated from the live listing rather than from the
 * artifact's self-attested counts.
 */
async function runPlanExecutor(
  cfg: Config,
  effective: Config,
  profile: ResourceTargetProfile,
  family: ResourceCommandFamily,
  argv: string[],
  limit: number,
  deps?: ResourcesCliDeps,
): Promise<{ ok: boolean; lines: string[] }> {
  const mode = effective.resourceMode;
  if (mode !== "publish" && mode !== "reconcile") throw new Error("executor requires --mode publish|reconcile");
  const planPath = argValue("--plan", argv);
  if (!planPath) {
    throw new Error(
      `${mode} requires --plan <file> written by --mode plan; the single-process ${mode} path was removed`,
    );
  }
  const execute = argv.includes("--execute");
  const confirmPlan = argValue("--confirm-plan", argv);
  const loaded = await readPlanArtifact(planPath);
  if (execute) {
    if (!confirmPlan) throw new Error("--execute requires --confirm-plan <sha256> printed by the planner");
    if (confirmPlan !== loaded.sha256) {
      throw new CodedResourceError("plan_drift", "--confirm-plan does not match the plan artifact");
    }
  }
  const live: PlanLiveIdentity = {
    kind: mode,
    family,
    configVersion: effective.resourceConfigVersion,
    pinSetVersion: RESOURCE_PIN_SET_VERSION,
    distHash: await currentDistHash(deps),
    target: profile.target,
    app: effective.resourceApp,
    publisherPk: expectedPublisher(argv, profile),
    homeserverPk: profile.homeserverPk,
    limit,
    fetch: fetchEnabled(argv, mode),
    policy: mode === "reconcile" ? reconcilePolicy(argv) : null,
    retired: mode === "reconcile" ? [...retiredLabels(argv)] : [],
    allowMassDelete: argv.includes("--allow-mass-delete"),
    allowHighDeleteRatio: argv.includes("--allow-high-delete-ratio"),
    tagger: taggerIdentity(cfg, argv),
  };
  assertPlanArtifactLive(loaded.artifact, live);
  assertArtifactDeleteCeilings(loaded.artifact);
  // A ledger-backed execution binds the artifact to its planner row and
  // enforces freshness between two database clock values; anything else
  // (a dry verification, or the database-free staging rehearsal) falls back
  // to the local clock.
  const sessionExpected = profile.target === "production" || deps?.pool !== undefined;
  if (!execute || !sessionExpected) {
    assertPlanArtifactFresh(loaded.artifact, Date.now());
  }
  if (!execute) {
    return { ok: true, lines: [executorSummary(loaded, { executed: false })] };
  }
  if (sessionExpected && !loaded.artifact.runId) {
    throw new CodedResourceError("plan_drift", "plan artifact does not reference the planner run that minted it");
  }
  const releaseLock = await acquireResourceRunLock();
  // The file lock serializes publishers inside one container; the session's
  // advisory lock serializes them across containers. Everything after the
  // lock is inside the try so a failing open cannot leak it.
  let transport: Transport | undefined;
  let session: ResourceRunSession | undefined;
  try {
    session = await openRunSession(
      effective,
      profile,
      family,
      0,
      deps,
      loaded.artifact.runId
        ? { planSha256: loaded.sha256, plannerRunId: loaded.artifact.runId, plannedAt: loaded.artifact.plannedAt }
        : undefined,
    );
    if (session) {
      // The one-hour window is enforced between the planner row's and this
      // run row's database timestamps; the executor's wall clock has no say.
      assertPlanArtifactFresh(loaded.artifact, session.startedAt?.getTime() ?? Date.now());
      const firstProductionWrite = await session.firstProductionWritePending();
      if (firstProductionWrite !== loaded.artifact.firstProductionWrite) {
        throw new CodedResourceError("plan_drift", "plan artifact does not match this run: first_production_write");
      }
    }
    // Production never reaches the root `signin()` transport: its only session
    // is the self-approved one scoped to Jeb's own tag subtree. The secret is
    // loaded at this single use site, never from the long-lived config object.
    transport =
      deps?.transport ??
      (profile.target === "production"
        ? await openProductionScopedTransport({ profile, testnet: cfg.testnet })
        : await (deps?.openTransport ?? openTransport)({
            secretKeyHex: secretFromEnv(),
            // The homeserver pin is the compiled target profile constant;
            // JEB_HOMESERVER is forbidden in an executor process.
            homeserverPk: profile.homeserverPk,
            signupToken: cfg.signupToken,
            testnet: cfg.testnet,
          }));
    if (transport.botPk !== loaded.artifact.publisherPk) {
      throw new CodedResourceError("config_refused", "session publisher does not match the plan artifact");
    }
    const outcome = await executePlanArtifact(loaded.artifact, transport);
    // Separate from homeserver readback: Nexus indexes asynchronously, so
    // this bounded check is recorded for the operator and never gates the run.
    const nexusVerified: NexusVerifyResult = await (deps?.nexusVerify ?? verifyNexusIndexed)({
      nexusUrl: profile.nexusUrl,
      timeoutMs: cfg.nexusTimeoutMs,
      written: loaded.artifact.actions.flatMap((action) =>
        action.kind === "put" ? [{ uri: action.body.uri, label: action.body.label }] : [],
      ),
    });
    await session?.finish({
      status: outcome.failed === 0 ? "succeeded" : "failed",
      accepted: loaded.artifact.resources.length,
      processed: loaded.artifact.resources.length,
      unprocessed: 0,
      written: outcome.written,
      skipped: outcome.skipped,
      failed: outcome.failed,
      puts: outcome.written,
      deletes: outcome.deletes,
      verified: outcome.verified,
      planSha256: loaded.sha256,
      // The payload carries the actual failure (readback_failed, plan_drift,
      // ...); the run row persists that code, not a generic one.
      failureCode: outcome.failed === 0 ? undefined : (outcome.failures[0]?.error ?? "homeserver_conflict"),
    });
    return {
      ok: outcome.failed === 0,
      lines: [
        executorSummary(loaded, {
          executed: true,
          written: outcome.written,
          skipped_existing: outcome.skipped,
          failed: outcome.failed,
          failures: outcome.failures,
          verified: outcome.verified,
          nexusVerified,
        }),
      ],
    };
  } catch (error) {
    await session?.fail(error);
    throw error;
  } finally {
    if (transport && "close" in transport && typeof transport.close === "function") {
      await transport.close();
    }
    await releaseLock();
  }
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
  // Staging keeps the historical truthiness check; the planner is keyless on
  // every target, so a present key source is itself the refusal.
  if (mode === "shadow") assertNoKeyMaterial();
  if (mode === "shadow" && target === "production") assertPlannerEnvContract();
  if (mode === "plan") {
    assertNoKeyMaterial();
    assertPlannerEnvContract();
  }
  assertResourceRunConfig(effective);
  assertProfileCoversApp(profile, effective.resourceApp);
  const limit = requiredPositiveIntegerFlag("--limit", argv, cfg.resourceMaxRecords);
  if (mode === "publish" || mode === "reconcile") {
    // The expected publisher and the executor env contract are validated
    // before Postgres, the key load, or any auth flow — on staging exactly
    // as on production; the production contract additionally requires the
    // single key source it will derive the session from.
    expectedPublisher(argv, profile);
    if (target === "production") assertExecutorEnvContract();
    else assertExecutorForbiddenEnv();
    return runPlanExecutor(cfg, effective, profile, family, argv, limit, deps);
  }
  if (mode === "plan") {
    return runPlanner(cfg, effective, profile, family, argv, limit, deps);
  }
  const discovered = await discoverFamilyRun(family, cfg, effective, argv, limit, profile, deps);
  const tagged = await applyModelTagger(discovered.run, effective, argv, profile, undefined, deps);
  const payload = { ...tagged, mode: "shadow", ...(discovered.canon ? { canon: discovered.canon } : {}) };
  return { ok: true, lines: [JSON.stringify(payload, null, 2)] };
}
