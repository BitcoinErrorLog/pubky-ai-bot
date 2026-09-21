import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Config } from "./config.js";
import { assertNoKeyMaterial } from "./keys.js";
import { RESOURCE_RECORD_MAX } from "./external-resources.js";
import { RESOURCE_PILOT_BOT_PK } from "./outbound-gate.js";
import { normalizeUri, resourceIdentity } from "./resource-identity.js";
import { PLAN_ARTIFACT_MAX_BYTES, readPlanArtifact, type ResourcePlanArtifact } from "./resource-plan-artifact.js";
import { publicTagReader } from "./resource-planner.js";
import {
  RESOURCE_WRITE_MAX,
  assertPublishableTagLabel,
  assertResourceAppName,
  buildUniversalResourceTag,
  isPublishableResourceUri,
  type ResourceTagBody,
} from "./resource-publish.js";
import { verifyNexusIndexed, type NexusFetchJson, type NexusVerifyMiss } from "./resource-nexus-verify.js";

/**
 * `--mode verify`: read-only reconciliation of the homeserver and Nexus
 * against the plan that was EXECUTED, never against a fresh discovery.
 *
 * Publish-mode sources (`pubky-posts`, `pubky-links`) skip already-tagged
 * resources at discovery time, so a second plan run derives a different set
 * and a `put 0 / delete 0` result says nothing about the run that landed.
 * Verify takes the executed artifact (or, for runs published before the plan
 * gate existed, the publish manifest that run printed), rebuilds every
 * expected tag path from (uri, label) under the pinned publisher, and checks
 * each one twice: the tag file is present on the homeserver with the same
 * uri/label, and Nexus lists the label with the publisher as a tagger.
 * No session is opened and no key material may be present in the process.
 */

export interface ExpectedTag {
  uri: string;
  label: string;
  path: string;
}

export interface ExecutedPlanInput {
  input: { kind: "plan" | "manifest"; path: string; sha256: string };
  publisherPk: string;
  app: string;
  configVersion: string;
  expected: ExpectedTag[];
}

export type VerifyMissReason =
  | "missing_on_homeserver"
  | "homeserver_body_mismatch"
  | "homeserver_unavailable"
  | NexusVerifyMiss["reason"];

export interface VerifyResult {
  mode: "verify";
  input: ExecutedPlanInput["input"];
  publisher: string;
  app: string;
  config_version: string;
  resources_total: number;
  resources_verified: number;
  tags_total: number;
  tags_homeserver_ok: number;
  tags_nexus_ok: number;
  nexus_attempts: number;
  misses: Array<{ uri: string; label: string; reason: VerifyMissReason }>;
  verified: boolean;
}

function argValue(flag: string, argv: readonly string[]): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith("-") ? argv[i + 1] : undefined;
}

function expectedFromArtifact(artifact: ResourcePlanArtifact): ExpectedTag[] {
  const expected: ExpectedTag[] = [];
  for (const action of artifact.actions) {
    if (action.kind !== "put") continue;
    expected.push({ uri: action.body.uri, label: action.body.label, path: action.path });
  }
  for (const resource of artifact.resources) {
    for (const label of resource.keep) {
      const built = buildUniversalResourceTag(artifact.publisherPk, artifact.app, resource.uri, label);
      expected.push({ uri: resource.uri, label, path: built.path });
    }
  }
  return dedupe(expected);
}

function dedupe(tags: ExpectedTag[]): ExpectedTag[] {
  const seen = new Set<string>();
  const out: ExpectedTag[] = [];
  for (const tag of tags) {
    if (seen.has(tag.path)) continue;
    seen.add(tag.path);
    out.push(tag);
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Legacy input: the JSON a pre-gate `--mode publish` run printed
 * (`publish.writes[]`), e.g. P2 `0a35322` and N3 `edb44c3`. Every write must
 * re-derive its recorded tag path under the pinned publisher, so a manifest
 * from another publisher, app, or an edited row is refused.
 */
export async function readLegacyPublishManifest(path: string): Promise<Omit<ExecutedPlanInput, "input"> & { sha256: string }> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    throw new Error("publish manifest cannot be read");
  }
  if (bytes.byteLength === 0 || bytes.byteLength > PLAN_ARTIFACT_MAX_BYTES) {
    throw new Error("publish manifest size is outside the allowed bound");
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("publish manifest is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("publish manifest is not an object");
  const publish = (parsed as { publish?: unknown }).publish;
  if (!publish || typeof publish !== "object" || Array.isArray(publish)) throw new Error("publish manifest is missing publish");
  const rec = publish as Record<string, unknown>;
  if (typeof rec.app !== "string" || typeof rec.configVersion !== "string" || !Array.isArray(rec.writes)) {
    throw new Error("publish manifest is missing app, configVersion, or writes");
  }
  if (rec.target !== undefined && rec.target !== "staging") throw new Error("publish manifest target is not staging");
  const app = assertResourceAppName(rec.app);
  if (rec.writes.length > RESOURCE_WRITE_MAX) throw new Error(`publish manifest carries ${rec.writes.length} writes; max is ${RESOURCE_WRITE_MAX}`);
  const expected: ExpectedTag[] = [];
  const uris = new Set<string>();
  for (const row of rec.writes) {
    if (!row || typeof row !== "object") throw new Error("publish manifest write is malformed");
    const write = row as Record<string, unknown>;
    if (typeof write.normalizedUri !== "string" || typeof write.label !== "string" || typeof write.tagPath !== "string") {
      throw new Error("publish manifest write is malformed");
    }
    const uri = normalizeUri(write.normalizedUri);
    if (uri !== write.normalizedUri) throw new Error("publish manifest uri is not normalized");
    if (!isPublishableResourceUri(uri)) throw new Error("publish manifest uri is not an allowed resource URI");
    assertPublishableTagLabel(write.label);
    if (typeof write.resourceIdentity === "string" && write.resourceIdentity !== resourceIdentity(uri)) {
      throw new Error("publish manifest resource identity does not match its uri");
    }
    const built = buildUniversalResourceTag(RESOURCE_PILOT_BOT_PK, app, uri, write.label);
    if (built.path !== write.tagPath) throw new Error("publish manifest tag path does not derive from its uri/label under the pinned publisher");
    uris.add(uri);
    expected.push({ uri, label: write.label, path: built.path });
  }
  if (uris.size > RESOURCE_RECORD_MAX) throw new Error(`publish manifest carries ${uris.size} resources; max is ${RESOURCE_RECORD_MAX}`);
  return { sha256, publisherPk: RESOURCE_PILOT_BOT_PK, app, configVersion: rec.configVersion, expected: dedupe(expected) };
}

export async function loadExecutedPlan(argv: readonly string[]): Promise<ExecutedPlanInput> {
  const planPath = argValue("--plan", argv);
  const manifestPath = argValue("--manifest", argv);
  const confirm = argValue("--confirm-plan", argv);
  if ((planPath && manifestPath) || (!planPath && !manifestPath)) {
    throw new Error("verify requires exactly one of --plan <artifact> or --manifest <publish-run-json>");
  }
  if (planPath) {
    const loaded = await readPlanArtifact(planPath);
    if (confirm !== undefined && confirm !== loaded.sha256) throw new Error("--confirm-plan does not match the plan artifact");
    return {
      input: { kind: "plan", path: planPath, sha256: loaded.sha256 },
      publisherPk: loaded.artifact.publisherPk,
      app: loaded.artifact.app,
      configVersion: loaded.artifact.configVersion,
      expected: expectedFromArtifact(loaded.artifact),
    };
  }
  const manifest = await readLegacyPublishManifest(manifestPath!);
  if (confirm !== undefined && confirm !== manifest.sha256) throw new Error("--confirm-plan does not match the publish manifest");
  return {
    input: { kind: "manifest", path: manifestPath!, sha256: manifest.sha256 },
    publisherPk: manifest.publisherPk,
    app: manifest.app,
    configVersion: manifest.configVersion,
    expected: manifest.expected,
  };
}

export interface VerifyDeps {
  homeserverRead?: (path: string) => Promise<ResourceTagBody | null>;
  fetchJson?: NexusFetchJson;
  nexusAttempts?: number;
  nexusBackoffMs?: number;
}

export async function verifyExecutedPlan(
  plan: ExecutedPlanInput,
  opts: { nexusUrl: string; timeoutMs: number; testnet: boolean },
  deps: VerifyDeps = {},
): Promise<VerifyResult> {
  const read = deps.homeserverRead ?? publicTagReader({ publisherPk: plan.publisherPk, testnet: opts.testnet, timeoutMs: opts.timeoutMs });
  const misses: VerifyResult["misses"] = [];
  const homeserverOk = new Set<string>();
  for (const tag of plan.expected) {
    let body: ResourceTagBody | null;
    try {
      body = await read(tag.path);
    } catch {
      misses.push({ uri: tag.uri, label: tag.label, reason: "homeserver_unavailable" });
      continue;
    }
    if (body === null) {
      misses.push({ uri: tag.uri, label: tag.label, reason: "missing_on_homeserver" });
      continue;
    }
    if (body.uri !== tag.uri || body.label !== tag.label) {
      misses.push({ uri: tag.uri, label: tag.label, reason: "homeserver_body_mismatch" });
      continue;
    }
    homeserverOk.add(tag.path);
  }
  const nexus = await verifyNexusIndexed({
    nexusUrl: opts.nexusUrl,
    timeoutMs: opts.timeoutMs,
    written: plan.expected.map((tag) => ({ uri: tag.uri, label: tag.label, publisherPk: plan.publisherPk })),
    fetchJson: deps.fetchJson,
    attempts: deps.nexusAttempts,
    backoffMs: deps.nexusBackoffMs,
  });
  for (const miss of nexus.misses) misses.push(miss);
  const nexusMissKeys = new Set(nexus.misses.map((miss) => `${miss.uri}\n${miss.label}`));
  const tagsNexusOk = plan.expected.filter((tag) => !nexusMissKeys.has(`${tag.uri}\n${tag.label}`)).length;
  const byResource = new Map<string, ExpectedTag[]>();
  for (const tag of plan.expected) {
    let rows = byResource.get(tag.uri);
    if (!rows) byResource.set(tag.uri, (rows = []));
    rows.push(tag);
  }
  const missedUris = new Set(misses.map((miss) => miss.uri));
  const resourcesVerified = [...byResource.keys()].filter((uri) => !missedUris.has(uri)).length;
  misses.sort((a, b) => a.uri.localeCompare(b.uri) || a.label.localeCompare(b.label) || a.reason.localeCompare(b.reason));
  return {
    mode: "verify",
    input: plan.input,
    publisher: plan.publisherPk,
    app: plan.app,
    config_version: plan.configVersion,
    resources_total: byResource.size,
    resources_verified: resourcesVerified,
    tags_total: plan.expected.length,
    tags_homeserver_ok: homeserverOk.size,
    tags_nexus_ok: tagsNexusOk,
    nexus_attempts: nexus.attempts,
    misses,
    verified: misses.length === 0 && plan.expected.length > 0,
  };
}

export async function runVerifyMode(
  cfg: Pick<Config, "nexusUrl" | "nexusTimeoutMs" | "testnet" | "resourceTarget">,
  argv: readonly string[],
  deps: VerifyDeps = {},
): Promise<{ ok: boolean; lines: string[] }> {
  assertNoKeyMaterial();
  if (cfg.resourceTarget !== "staging") throw new Error("external-resource seeding is staging-only");
  const plan = await loadExecutedPlan(argv);
  const result = await verifyExecutedPlan(plan, { nexusUrl: cfg.nexusUrl, timeoutMs: cfg.nexusTimeoutMs, testnet: cfg.testnet }, deps);
  return { ok: result.verified, lines: [JSON.stringify(result, null, 2)] };
}
