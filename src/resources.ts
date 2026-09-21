import { mkdir, open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import type { Config } from "./config.js";
import { assertNoKeyMaterial } from "./keys.js";
import { discoverCrawlerResources } from "./crawler-resources.js";
import { BITCOIN_CANON_SOURCE_ID, discoverBitcoinCanon, toResourceInputs } from "./resource-canon.js";
import {
  assertDiscoveryHaltAllowsPublish,
  assertStagingResourceConfig,
  discoverResources,
  RESOURCE_INPUT_MAX_BYTES,
  type ExternalResourceInput,
  type ResourceRun,
  validateResourceLimit,
} from "./external-resources.js";
import { openTransport, type Transport } from "./homeserver.js";
import { CodedResourceError } from "./resource-error-code.js";
import { resolveResourceCommandFamily, type ResourceCommandFamily } from "./resource-command-family.js";
import {
  assertStagingHomeserverPk,
  RESOURCE_PILOT_BOT_PK,
  STAGING_HOMESERVER_PK,
} from "./outbound-gate.js";
import {
  assertPublishableTagLabel,
  reconcileResourceTags,
  type ReconcilePolicy,
  type ResourcePublishManifest,
  type ResourceReconcilePlan,
} from "./resource-publish.js";
import {
  assertPlanArtifactFresh,
  assertPlanArtifactLive,
  readPlanArtifact,
  writePlanArtifact,
  type PlanLiveIdentity,
} from "./resource-plan-artifact.js";
import {
  buildPublishPlanArtifact,
  publicTagReader,
  type ExistingTagReader,
  type PlanIdentityInput,
} from "./resource-planner.js";
import { executePlanArtifact } from "./resource-plan-executor.js";
import { runVerifyMode, type VerifyDeps } from "./resource-verify.js";
import { nexusResourceTagInventory, nexusResourceTags, tagResource, type TaggedResource } from "./resource-tagger.js";
import { PERSON_GATE_VERSION } from "./person-gate.js";
import { RESOURCE_CONFIG_VERSION } from "./resource-taxonomy.js";
import { sourceTreeHash } from "./source-tree-hash.js";
import { discoverPubkyPosts } from "./resource-posts.js";
import { Nexus } from "./nexus.js";
import { createPublicHomeserverReader } from "./pubchi/homeserver-read.js";
import { discoverBtcMapPlaces } from "./resource-places.js";
import { discoverNews, NEWS_SOURCE_ID } from "./resource-news.js";
import { discoverWalletDirectory, writeN2LabelsReport, WALLET_DIRECTORY_SOURCE_ID } from "./resource-wallets.js";
import {
  discoverPubkyEcosystem,
  PUBKY_ECOSYSTEM_SOURCE_ID,
  PUBKY_ECOSYSTEM_SUB_SOURCES,
} from "./resource-ecosystem.js";
import { discoverLegalResources, legalSleep, type LegalDiscoveryOptions } from "./resource-legal.js";

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

export function parseExcludedEcosystemSubSources(argv: string[]): ReadonlySet<string> {
  const excluded = new Set(argValues("--exclude-source", argv));
  for (const subSource of excluded) {
    if (!(PUBKY_ECOSYSTEM_SUB_SOURCES as readonly string[]).includes(subSource)) {
      throw new Error(`invalid --exclude-source (${PUBKY_ECOSYSTEM_SUB_SOURCES.join("|")})`);
    }
  }
  return excluded;
}

function argvAfterRole(argv: string[]): string[] {
  const roleIdx = argv.indexOf("--role");
  return roleIdx >= 0 ? argv.slice(roleIdx + 2) : argv.slice(2);
}

export function resourceCliMode(argv: string[], fallback: Config["resourceMode"]): Config["resourceMode"] {
  const raw = (argValue("--mode", argv) ?? fallback).trim().toLowerCase();
  if (raw === "shadow" || raw === "plan" || raw === "publish" || raw === "reconcile" || raw === "verify") return raw;
  throw new Error("invalid --mode (shadow|plan|publish|reconcile|verify)");
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
  /** Test seam for the planner's existing-state public reads. */
  existingTagReader?: ExistingTagReader;
  /** Test seam for verify mode's public homeserver and Nexus reads. */
  verify?: VerifyDeps;
  /** Test seam for adapters that fetch feeds or directories during discovery. */
  fetchImpl?: typeof fetch;
  /** Test seams for the legal adapter's DNS preflight and polite-pool pacing. */
  dnsLookup?: LegalDiscoveryOptions["dnsLookup"];
  sleep?: (ms: number) => Promise<void>;
  /** Set when the caller already holds the resource-run lock for this process. */
  resourceRunLockHeld?: boolean;
  resourceRunLockDir?: string;
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

function taggerIdentity(cfg: Config, argv: string[]): { id: "rules" | "model"; model: string | null } {
  const id = taggerMode(argv);
  return { id, model: id === "model" ? cfg.model : null };
}

/** Per-family capabilities: API-only sources never fetch pages for model tagging. */
const RESOURCE_SOURCE_CAPABILITIES: Readonly<Record<ResourceCommandFamily, { modelTagging: boolean; pageFetch: boolean }>> = {
  discover: { modelTagging: true, pageFetch: true },
  crawl: { modelTagging: true, pageFetch: true },
  places: { modelTagging: true, pageFetch: true },
  canon: { modelTagging: true, pageFetch: true },
  "pubky-posts": { modelTagging: true, pageFetch: true },
  news: { modelTagging: true, pageFetch: true },
  "wallet-directory": { modelTagging: true, pageFetch: true },
  "pubky-ecosystem": { modelTagging: true, pageFetch: true },
  legal: { modelTagging: true, pageFetch: false },
};

function fetchEnabled(argv: string[], family: ResourceCommandFamily): boolean {
  return RESOURCE_SOURCE_CAPABILITIES[family].pageFetch && argv.includes("--fetch") && taggerMode(argv) === "model";
}

const USAGE = [
  "usage: --role resources discover --input <json-file> [--limit <1-100>] [--mode shadow|plan|publish|reconcile] [--target staging]",
  "   or: --role resources crawl --db <sqlite-file> --source <source> --label <taxonomy-label> [--label <taxonomy-label>] [--limit 1-100] [--mode shadow|plan|publish|reconcile] [--target staging] [--fetch]",
  "   or: --role resources --source pubky-posts [--limit 1-100] [--mode shadow|plan|publish] [--tagger model] [--fetch]",
  "   or: --role resources places [--limit 1-100] [--mode shadow|plan|publish|reconcile] [--target staging]",
  "   or: --role resources canon --source bitcoin-canon [--limit 1-100] [--mode shadow|plan|publish|reconcile] [--target staging] [--tagger rules|model] [--fetch]",
  "   or: --role resources --source news [--limit 1-100] [--mode shadow|plan|publish|reconcile] [--target staging] [--tagger rules|model]",
  "   or: --role resources --source wallet-directory [--limit 1-100] [--mode shadow|plan|publish] [--tagger rules|model] [--fetch] [--labels-out <md-file>]",
  "   or: --role resources --source pubky-ecosystem [--limit 1-100] [--mode shadow|plan|publish] [--tagger rules|model] [--exclude-source <sub-source>]... [--labels-out <md-file>]",
  "   or: --role resources legal --source legal [--limit 1-100] [--mode shadow|plan|publish|reconcile] [--target staging] [--tagger rules|model]",
  "publish is a three-step flow:",
  "  1) --mode plan --plan-out <file>                                  (keyless planner; prints plan_sha256)",
  "  2) --mode publish --plan <file>                                   (keyless dry check of the confirmed plan)",
  "  3) --mode publish --plan <file> --execute --confirm-plan <sha256> (executes exactly the confirmed plan)",
  "verify is keyless and read-only against the EXECUTED plan, never a fresh discovery:",
  "      --mode verify --plan <file> [--confirm-plan <sha256>]          (homeserver tag files + Nexus by-uri, per tag)",
  "      --mode verify --manifest <publish-run-json>                    (runs published before the plan gate)",
];

async function writeN3Report(run: ResourceRun, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const rows = run.accepted.map((resource) => {
    const labels = resource.labels.join(", ");
    const subSource = String(resource.metadata?.subSource ?? "unknown");
    const components = Object.entries(resource.provenance.scoreComponents ?? {}).map(([key, value]) => `${key}=${value}`).join(", ");
    return `| [${resource.canonicalValue}](${resource.canonicalValue}) | ${subSource} | ${labels} | ${components} |`;
  });
  await writeFile(path, [
    "# N3 Pubky ecosystem labels",
    "",
    "| URL | Sub-source | Labels | Score components |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
    `Accepted: ${run.accepted.length}; rejected: ${run.rejected.length}`,
  ].join("\n"));
}

function reconcilePolicy(argv: string[]): ReconcilePolicy {
  const value = argValue("--reconcile", argv);
  if (value !== "retired" && value !== "full") throw new Error("reconcile mode requires --reconcile retired|full");
  return value;
}

/** Re-exported so CLI callers and tests keep one import site for the discovery-halt guard. */
export { assertDiscoveryHaltAllowsPublish };

export function assertResourceRunPublishable(run: ResourceRun): void {
  assertDiscoveryHaltAllowsPublish(run);
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

export async function acquireResourceRunLock(lockDir = join(process.cwd(), "data")): Promise<() => Promise<void>> {
  const lockPath = join(lockDir, "resource-publish.lock");
  await mkdir(lockDir, { recursive: true });
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

type DiscoveredRun = {
  run: ResourceRun;
  sourceId: string;
  canon?: { candidates: number };
  legal?: { federalRegister: number; edgar: number };
};

async function loadDiscoverInput(inputPath: string, limit: number, cfg: Config): Promise<DiscoveredRun> {
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
  return { run, sourceId: createHash("sha256").update(input).digest("hex") };
}

function requestedLimit(argv: string[], cfg: Config): number {
  const limitRaw = argValue("--limit", argv);
  return validateResourceLimit(limitRaw ? Number(limitRaw) : cfg.resourceMaxRecords);
}

/** Per-family discovery; the family was resolved once from the raw CLI. */
async function discoverFamilyRun(
  family: ResourceCommandFamily,
  cfg: Config,
  argv: string[],
  deps?: ResourcesCliDeps,
): Promise<DiscoveredRun> {
  const limit = requestedLimit(argv, cfg);
  if (family === "pubky-posts") {
    const nexus = new Nexus(cfg.nexusUrl, cfg.nexusTimeoutMs);
    const run = await discoverPubkyPosts({
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
    return { run, sourceId: `nexus:${cfg.nexusUrl}` };
  }
  if (family === "places") {
    const run = await discoverBtcMapPlaces({
      limit,
      configVersion: cfg.resourceConfigVersion,
      cacheDir: cfg.resourceCacheDir,
    });
    return { run, sourceId: "btcmap" };
  }
  if (family === "news") {
    const run = await discoverNews({
      limit,
      cacheDir: join(cfg.resourceCacheDir, "fetch"),
      fetchImpl: deps?.fetchImpl,
      configVersion: cfg.resourceConfigVersion,
    });
    return { run, sourceId: NEWS_SOURCE_ID };
  }
  if (family === "wallet-directory") {
    const nexusTags = nexusResourceTags(cfg.nexusUrl, cfg.nexusTimeoutMs);
    const run = await discoverWalletDirectory({
      limit,
      configVersion: cfg.resourceConfigVersion,
      isAlreadyTagged: async (url) => {
        try {
          return (await nexusTags({
            family: "url",
            value: url,
            source: WALLET_DIRECTORY_SOURCE_ID,
            labels: [],
          } as never)).length > 0;
        } catch {
          return false;
        }
      },
    });
    return { run, sourceId: WALLET_DIRECTORY_SOURCE_ID };
  }
  if (family === "pubky-ecosystem") {
    const excludeSubSources = parseExcludedEcosystemSubSources(argv);
    const nexusTags = nexusResourceTags(cfg.nexusUrl, cfg.nexusTimeoutMs);
    const run = await discoverPubkyEcosystem({
      limit,
      configVersion: cfg.resourceConfigVersion,
      excludeSubSources,
      existingTags: async (input) => nexusTags({
        family: "url",
        category: "pubky",
        displayValue: input.value,
        canonicalValue: input.value,
        identity: "",
        labels: input.labels,
        taxonomy: { domain: [], type: [], subject: [], geography: [], sourceStatus: [] },
        rules: [],
        score: 0,
        sourcePriority: input.sourcePriority ?? 0,
        provenance: { source: input.source, configVersion: cfg.resourceConfigVersion, decision: "accepted", timestamp: new Date().toISOString() },
      }),
    });
    return { run, sourceId: PUBKY_ECOSYSTEM_SOURCE_ID };
  }
  if (family === "legal") {
    const run = await discoverLegalResources({
      limit,
      configVersion: cfg.resourceConfigVersion,
      contactEmail: process.env.JEB_CONTACT_EMAIL,
      cacheDir: cfg.resourceCacheDir,
      fetchImpl: deps?.fetchImpl,
      dnsLookup: deps?.dnsLookup,
      sleep: deps?.sleep ?? legalSleep,
    });
    return { run, sourceId: "legal", legal: run.legalSubSources };
  }
  if (family === "crawl") {
    const dbPath = argValue("--db", argv) ?? "";
    const source = argValue("--source", argv) ?? "";
    const labels = argValues("--label", argv);
    const run = await discoverCrawlerResources({ dbPath, source, labels, limit });
    const sourceId = createHash("sha256")
      .update(JSON.stringify({ db: dbPath, source, labels: [...labels].sort() }))
      .digest("hex");
    return { run, sourceId };
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
  return loadDiscoverInput(argValue("--input", argv) ?? "", limit, cfg);
}

type TaggedRun = ResourceRun & { tagger: { resources: TaggedResource[]; summary: Record<string, unknown> } };

function modelHaltReason(tagged: TaggedRun): string | null {
  const halt = (tagged.tagger?.summary as { halt?: { reason: string } | null } | undefined)?.halt;
  return halt?.reason.split(",").includes("model-failure-rate") ? halt.reason : null;
}

/** The keyless planner: discover, tag, write one canonical artifact. */
async function runPlanner(
  cfg: Config,
  effective: Config,
  family: ResourceCommandFamily,
  argv: string[],
  discovered: DiscoveredRun,
  tagged: TaggedRun,
  deps?: ResourcesCliDeps,
): Promise<{ ok: boolean; lines: string[] }> {
  const planOut = argValue("--plan-out", argv);
  if (!planOut) throw new Error("--mode plan requires --plan-out <path>");
  assertResourceRunPublishable(tagged);
  const halt = modelHaltReason(tagged);
  if (halt) throw new Error(`resource plan refused: ${halt}`);
  if (cfg.botPk && cfg.botPk !== RESOURCE_PILOT_BOT_PK) {
    throw new Error("resource plan refused: JEB_BOT_PK does not match the pinned resource pilot");
  }
  const gitHead = deps?.gitHead ?? currentGitHead();
  if (!gitHead) throw new Error("resource plan refused: git rev-parse HEAD is unavailable");
  const releaseLock = deps?.resourceRunLockHeld ? undefined : await acquireResourceRunLock(deps?.resourceRunLockDir);
  try {
    const identity: PlanIdentityInput = {
      family,
      sourceId: discovered.sourceId,
      tagger: taggerIdentity(cfg, argv),
      configVersion: effective.resourceConfigVersion,
      sourceHash: await sourceTreeHash(),
      gitHead,
      app: effective.resourceApp,
      publisherPk: RESOURCE_PILOT_BOT_PK,
      homeserverPk: STAGING_HOMESERVER_PK,
      limit: tagged.limit,
      fetch: fetchEnabled(argv, family),
    };
    const artifact = await buildPublishPlanArtifact(
      tagged.accepted,
      identity,
      deps?.existingTagReader ??
        publicTagReader({ publisherPk: RESOURCE_PILOT_BOT_PK, testnet: cfg.testnet, timeoutMs: cfg.nexusTimeoutMs }),
    );
    const planSha256 = await writePlanArtifact(planOut, artifact);
    const summary = {
      mode: "plan",
      plan_sha256: planSha256,
      plan_out: planOut,
      family,
      target: "staging",
      app: effective.resourceApp,
      puts: artifact.actions.length,
      keeps: artifact.resources.reduce((n, r) => n + r.keep.length, 0),
      resources: artifact.resources.length,
      tagger: artifact.tagger,
      config_version: effective.resourceConfigVersion,
      git_head: gitHead,
    };
    const payload = { ...tagged, mode: "plan", ...(discovered.canon ? { canon: discovered.canon } : {}), ...(discovered.legal ? { legal: discovered.legal } : {}) };
    return { ok: true, lines: [JSON.stringify(summary), JSON.stringify(payload, null, 2)] };
  } finally {
    await releaseLock?.();
  }
}

/**
 * The key-bearing executor. It performs no discovery, no fetch, and no
 * tagging: it loads the planner's immutable artifact, re-verifies its hash
 * and every identity field against the live process, and only then executes
 * exactly those actions. Without --execute it is a keyless dry check.
 */
async function runPlanPublish(
  cfg: Config,
  effective: Config,
  family: ResourceCommandFamily,
  argv: string[],
  deps?: ResourcesCliDeps,
): Promise<{ ok: boolean; lines: string[] }> {
  const planPath = argValue("--plan", argv);
  if (!planPath) {
    throw new Error("publish requires --plan <file> written by --mode plan; the single-process publish path was removed");
  }
  const execute = argv.includes("--execute");
  const loaded = await readPlanArtifact(planPath);
  if (execute) {
    const confirmPlan = argValue("--confirm-plan", argv);
    if (!confirmPlan) throw new Error("--execute requires --confirm-plan <sha256> printed by the planner");
    if (confirmPlan !== loaded.sha256) {
      throw new CodedResourceError("plan_drift", "--confirm-plan does not match the plan artifact");
    }
  }
  const gitHead = deps?.gitHead ?? currentGitHead();
  if (!gitHead) throw new Error("resource publish refused: git rev-parse HEAD is unavailable");
  const live: PlanLiveIdentity = {
    kind: "publish",
    family,
    configVersion: effective.resourceConfigVersion,
    sourceHash: await sourceTreeHash(),
    gitHead,
    target: "staging",
    app: effective.resourceApp,
    publisherPk: RESOURCE_PILOT_BOT_PK,
    homeserverPk: STAGING_HOMESERVER_PK,
    limit: requestedLimit(argv, cfg),
    fetch: fetchEnabled(argv, family),
    tagger: taggerIdentity(cfg, argv),
  };
  assertPlanArtifactLive(loaded.artifact, live);
  assertPlanArtifactFresh(loaded.artifact, Date.now());
  if (!execute) {
    return {
      ok: true,
      lines: [JSON.stringify({
        mode: "publish",
        executed: false,
        plan_sha256: loaded.sha256,
        family,
        puts: loaded.artifact.actions.length,
        resources: loaded.artifact.resources.length,
      }, null, 2)],
    };
  }
  const releaseLock = deps?.resourceRunLockHeld ? undefined : await acquireResourceRunLock(deps?.resourceRunLockDir);
  // The lock serializes local publishers. Homeserver writes can still race with
  // an external client; fresh reads and readback verification remain the defense.
  try {
    const transport =
      deps?.transport ??
      (await (deps?.openTransport ?? openTransport)({
        secretKeyHex: cfg.secretKeyHex,
        homeserverPk: cfg.homeserverPk,
        signupToken: cfg.signupToken,
        testnet: cfg.testnet,
      }));
    assertStagingHomeserverPk(transport.resolvedHomeserverPk ?? "");
    const outcome = await executePlanArtifact(loaded.artifact, transport);
    return {
      ok: outcome.failed === 0,
      lines: [JSON.stringify({
        mode: "publish",
        executed: true,
        plan_sha256: loaded.sha256,
        puts: outcome.puts,
        written: outcome.written,
        skipped: outcome.skipped,
        failed: outcome.failed,
        failures: outcome.failures,
        verified: outcome.verified,
      }, null, 2)],
    };
  } finally {
    await releaseLock?.();
  }
}

async function runReconcile(
  tagged: TaggedRun,
  effective: Config,
  argv: string[],
  discovered: DiscoveredRun,
  deps?: ResourcesCliDeps,
): Promise<{ ok: boolean; lines: string[] }> {
  assertResourceRunPublishable(tagged);
  const halt = modelHaltReason(tagged);
  if (halt) throw new Error(`resource publish/reconcile refused: ${halt}`);
  const releaseLock = deps?.resourceRunLockHeld ? undefined : await acquireResourceRunLock(deps?.resourceRunLockDir);
  try {
    const transport =
      deps?.transport ??
      (await (deps?.openTransport ?? openTransport)({
        secretKeyHex: effective.secretKeyHex,
        homeserverPk: effective.homeserverPk,
        signupToken: effective.signupToken,
        testnet: effective.testnet,
      }));
    const policy = reconcilePolicy(argv);
    const retired = retiredLabels(argv);
    const expectedPilotPk = argValue("--expected-pk", argv) ?? process.env.JEB_RECONCILE_EXPECTED_PK?.trim() ?? "";
    if (!expectedPilotPk) throw new Error("reconcile requires --expected-pk or JEB_RECONCILE_EXPECTED_PK");
    if (expectedPilotPk !== RESOURCE_PILOT_BOT_PK) throw new Error("reconcile pilot pin constant/flag mismatch");
    const reconciled = await reconcileResourceTags(tagged.accepted, {
      resourceTarget: effective.resourceTarget,
      resourceApp: effective.resourceApp,
      resourceConfigVersion: effective.resourceConfigVersion,
      expectedPilotPk,
      policy,
      retired,
      execute: argv.includes("--execute"),
      confirmPlan: argValue("--confirm-plan", argv),
    }, transport);
    return { ok: true, lines: [JSON.stringify({ ...tagged, mode: "reconcile", ...(discovered.canon ? { canon: discovered.canon } : {}), publish: { configVersion: effective.resourceConfigVersion, app: effective.resourceApp, target: "staging", written: 0, skipped_existing: 0, failed: 0, writes: [], failures: [], reconcile: reconcileLines(reconciled.plan, reconciled.planSha256, { policy, botPk: transport.botPk, resolvedHomeserverPk: transport.resolvedHomeserverPk, resourceConfigVersion: effective.resourceConfigVersion }) } as ResourcePublishManifest & { reconcile: string[] } }, null, 2)] };
  } finally {
    await releaseLock?.();
  }
}

async function applyModelTagger(run: ResourceRun, cfg: Config, argv: string[], family: ResourceCommandFamily): Promise<TaggedRun> {
  if (taggerMode(argv) !== "model") return { ...run, tagger: { resources: [], summary: { mode: "rules" } } };
  const useFetch = fetchEnabled(argv, family);
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
        ...(tagged.personGate || resource.provenance.personGate
          ? {
            personGate: {
              version: tagged.personGate?.version ?? resource.provenance.personGate!.version,
              dropped: [...(resource.provenance.personGate?.dropped ?? []), ...(tagged.personGate?.dropped ?? [])],
            },
          }
          : {}),
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
  const personGateDrops: Record<string, number> = Object.create(null);
  let personGateVersion: string | undefined;
  const labelCounts: Record<string, number> = Object.create(null);
  for (const item of resources) {
    if (item.personGate) {
      personGateVersion = item.personGate.version;
      for (const drop of item.personGate.dropped) countTagger(personGateDrops, drop.reason);
    }
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
        personGate: { version: personGateVersion ?? PERSON_GATE_VERSION, droppedByReason: personGateDrops },
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
  const execute = argv.includes("--execute");
  if (mode === "shadow" || mode === "plan" || mode === "verify" || !execute) assertNoKeyMaterial();
  assertStagingResourceConfig(effective);
  if (mode === "verify") {
    // Verify names no family: its input is the executed plan, not a discovery.
    return runVerifyMode(effective, argv, deps?.verify);
  }
  const family = resolveResourceCommandFamily(argvAfterRole(argv));
  if (family === "legal" && argv.includes("--fetch")) {
    return { ok: false, lines: ["legal refuses --fetch: API-only sources use structured fields"] };
  }
  if (mode === "publish") {
    return runPlanPublish(cfg, effective, family, argv, deps);
  }
  if (family === "legal" && !deps?.resourceRunLockHeld) {
    // Legal discovery talks to polite-pool APIs: the resource-run lock refuses
    // overlapping legal processes before their first request, and the same
    // lock is then held through the planner or reconcile.
    const releaseLock = await acquireResourceRunLock(deps?.resourceRunLockDir);
    try {
      return await runResourcesCli(cfg, argv, { ...deps, resourceRunLockHeld: true });
    } finally {
      await releaseLock();
    }
  }
  const discovered = await discoverFamilyRun(family, effective, argv, deps);
  const tagged = await applyModelTagger(discovered.run, effective, argv, family);
  const labelsOut = argValue("--labels-out", argv);
  if (labelsOut && family === "pubky-ecosystem") await writeN3Report(discovered.run, labelsOut);
  if (labelsOut && family === "wallet-directory") {
    await writeN2LabelsReport(tagged.accepted.map((resource) => ({
      ...resource,
      labels: tagged.tagger.resources.find((item) => item.url === resource.canonicalValue)?.labels ?? resource.labels,
    })), taggerMode(argv), labelsOut);
  }
  if (mode === "plan") {
    return runPlanner(cfg, effective, family, argv, discovered, tagged, deps);
  }
  if (mode === "shadow") {
    const payload = { ...tagged, mode: "shadow", ...(discovered.canon ? { canon: discovered.canon } : {}), ...(discovered.legal ? { legal: discovered.legal } : {}) };
    return { ok: true, lines: [JSON.stringify(payload, null, 2)] };
  }
  return runReconcile(tagged, effective, argv, discovered, deps);
}
