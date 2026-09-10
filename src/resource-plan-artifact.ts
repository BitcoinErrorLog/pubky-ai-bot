import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { CodedResourceError } from "./resource-error-code.js";
import type { ResourceCommandFamily } from "./resource-command-family.js";
import {
  PRODUCTION_PER_RESOURCE_DELETE_RATIO,
  productionFullDeleteCeiling,
  type ReconcilePolicy,
  type ResourceTagBody,
} from "./resource-publish.js";
import { RESOURCE_PIN_SET_VERSION, type ResourceTarget } from "./resource-target-profile.js";

/**
 * The immutable planner artifact.
 *
 * The keyless planner writes exactly one canonical JSON document; the
 * key-bearing executor loads it, verifies its SHA-256 and every identity
 * field against the live process, and performs only the actions it names.
 * Canonicalization (recursively sorted keys, deterministic action order) is
 * what makes the hash an operator-reviewable commitment: two planners that
 * computed the same plan from the same build produce byte-identical files.
 */

export const PLAN_ARTIFACT_KIND = "jeb-resource-plan";
export const PLAN_ARTIFACT_VERSION = 1;
/** A confirmed plan must be executed within this window of its planner timestamp. */
export const PLAN_ARTIFACT_MAX_AGE_MS = 60 * 60 * 1000;
/** Well above the largest legal plan (100 resources x 10 labels). */
export const PLAN_ARTIFACT_MAX_BYTES = 8 * 1024 * 1024;

export type PlanArtifactAction =
  | { kind: "put"; path: string; body: ResourceTagBody }
  | { kind: "delete"; path: string; label: string; uri: string };

/** Per-resource counts so the executor can re-evaluate every delete ceiling. */
export interface PlanArtifactResource {
  resourceId: string;
  /** Labels the plan keeps (already on the homeserver and still desired). */
  keep: string[];
  /** Labels left untouched because policy protects them. */
  protected: string[];
  puts: number;
  deletes: number;
}

/**
 * Plan-time ceiling evaluation, recorded for operator review. These fields
 * are informational: the executor re-evaluates every ceiling from the LIVE
 * homeserver listing plus the artifact's actions, so a crafted value here
 * cannot raise a ceiling at execution time.
 */
export interface PlanArtifactCeilings {
  /** min(50, floor(20% of listed)) for a production full reconcile; null otherwise. */
  deleteCeiling: number | null;
  perResourceDeleteRatio: number;
  puts: number;
  deletes: number;
  /** Violation kinds observed at plan time; a written plan always has none. */
  violations: string[];
}

export interface ResourcePlanArtifact {
  artifact: typeof PLAN_ARTIFACT_KIND;
  version: typeof PLAN_ARTIFACT_VERSION;
  kind: "publish" | "reconcile";
  family: ResourceCommandFamily;
  /** Family-specific input identity (e.g. the discover input file digest). */
  sourceId: string;
  tagger: { id: "rules" | "model"; model: string | null };
  configVersion: string;
  pinSetVersion: string;
  distHash: string;
  target: ResourceTarget;
  app: string;
  publisherPk: string;
  homeserverPk: string;
  limit: number;
  fetch: boolean;
  policy: ReconcilePolicy | null;
  retired: string[];
  allowMassDelete: boolean;
  allowHighDeleteRatio: boolean;
  /** Listed tag-file count and digest from planning time (reconcile only). */
  listed: number | null;
  listedDigest: string | null;
  /** Ledger run id and reservation of the planner run that produced this plan. */
  runId: string | null;
  reservedUsd: number | null;
  /** Ledger-derived: no successful production run with writes exists yet. */
  firstProductionWrite: boolean;
  plannedAt: string;
  ceilings: PlanArtifactCeilings;
  resources: PlanArtifactResource[];
  actions: PlanArtifactAction[];
}

/** Deterministic JSON: object keys sorted recursively, arrays in given order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export function planArtifactSha256(artifact: ResourcePlanArtifact): string {
  return createHash("sha256").update(canonicalJson(artifact)).digest("hex");
}

/** Canonical bytes: the only form a planner writes and an executor hashes. */
export function planArtifactBytes(artifact: ResourcePlanArtifact): Buffer {
  return Buffer.from(canonicalJson(artifact), "utf8");
}

export async function writePlanArtifact(path: string, artifact: ResourcePlanArtifact): Promise<string> {
  const bytes = planArtifactBytes(artifact);
  await writeFile(path, bytes, { encoding: "utf8", mode: 0o600 });
  return createHash("sha256").update(bytes).digest("hex");
}

function isTagBody(value: unknown): value is ResourceTagBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  return typeof rec.uri === "string" && typeof rec.label === "string" && typeof rec.created_at === "number";
}

function validateAction(value: unknown): value is PlanArtifactAction {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  if (rec.kind === "put") return typeof rec.path === "string" && isTagBody(rec.body);
  if (rec.kind === "delete") {
    return typeof rec.path === "string" && typeof rec.label === "string" && typeof rec.uri === "string";
  }
  return false;
}

function validateResource(value: unknown): value is PlanArtifactResource {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  const labels = (v: unknown) => Array.isArray(v) && v.every((label) => typeof label === "string");
  return (
    typeof rec.resourceId === "string" &&
    labels(rec.keep) &&
    labels(rec.protected) &&
    typeof rec.puts === "number" &&
    typeof rec.deletes === "number"
  );
}

/** Structural validation; semantic identity checks are `assertPlanArtifactLive`. */
export function validatePlanArtifact(value: unknown): ResourcePlanArtifact {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CodedResourceError("plan_drift", "plan artifact is not an object");
  }
  const rec = value as Record<string, unknown>;
  if (rec.artifact !== PLAN_ARTIFACT_KIND) throw new CodedResourceError("plan_drift", "plan artifact kind is unknown");
  if (rec.version !== PLAN_ARTIFACT_VERSION) throw new CodedResourceError("plan_drift", "plan artifact version is unknown");
  if (rec.kind !== "publish" && rec.kind !== "reconcile") {
    throw new CodedResourceError("plan_drift", "plan artifact mode is unknown");
  }
  const strings = ["family", "sourceId", "configVersion", "pinSetVersion", "distHash", "target", "app", "publisherPk", "homeserverPk", "plannedAt"] as const;
  for (const key of strings) {
    if (typeof rec[key] !== "string" || rec[key] === "") {
      throw new CodedResourceError("plan_drift", `plan artifact field is missing: ${key}`);
    }
  }
  const tagger = rec.tagger as Record<string, unknown> | undefined;
  if (
    !tagger ||
    (tagger.id !== "rules" && tagger.id !== "model") ||
    !(tagger.model === null || typeof tagger.model === "string")
  ) {
    throw new CodedResourceError("plan_drift", "plan artifact tagger is malformed");
  }
  if (typeof rec.limit !== "number" || !Number.isInteger(rec.limit) || rec.limit < 1 || rec.limit > 100) {
    throw new CodedResourceError("plan_drift", "plan artifact limit is malformed");
  }
  if (typeof rec.fetch !== "boolean" || typeof rec.allowMassDelete !== "boolean" || typeof rec.allowHighDeleteRatio !== "boolean" || typeof rec.firstProductionWrite !== "boolean") {
    throw new CodedResourceError("plan_drift", "plan artifact flags are malformed");
  }
  if (!(rec.policy === null || rec.policy === "retired" || rec.policy === "full")) {
    throw new CodedResourceError("plan_drift", "plan artifact policy is malformed");
  }
  if (!Array.isArray(rec.retired) || !rec.retired.every((label) => typeof label === "string")) {
    throw new CodedResourceError("plan_drift", "plan artifact retired labels are malformed");
  }
  if (!(rec.listed === null || typeof rec.listed === "number") || !(rec.listedDigest === null || typeof rec.listedDigest === "string")) {
    throw new CodedResourceError("plan_drift", "plan artifact listing digest is malformed");
  }
  if (!(rec.runId === null || typeof rec.runId === "string") || !(rec.reservedUsd === null || typeof rec.reservedUsd === "number")) {
    throw new CodedResourceError("plan_drift", "plan artifact ledger identity is malformed");
  }
  const ceilings = rec.ceilings as Record<string, unknown> | undefined;
  if (
    !ceilings ||
    !(ceilings.deleteCeiling === null || typeof ceilings.deleteCeiling === "number") ||
    typeof ceilings.perResourceDeleteRatio !== "number" ||
    typeof ceilings.puts !== "number" ||
    typeof ceilings.deletes !== "number" ||
    !Array.isArray(ceilings.violations) ||
    !ceilings.violations.every((v) => typeof v === "string")
  ) {
    throw new CodedResourceError("plan_drift", "plan artifact ceilings are malformed");
  }
  if (!Array.isArray(rec.actions) || !rec.actions.every(validateAction)) {
    throw new CodedResourceError("plan_drift", "plan artifact actions are malformed");
  }
  if (!Array.isArray(rec.resources) || !rec.resources.every(validateResource)) {
    throw new CodedResourceError("plan_drift", "plan artifact resources are malformed");
  }
  const artifact = value as ResourcePlanArtifact;
  // Cross-field consistency: the counts the executor re-checks must be the
  // counts the actions actually carry.
  const puts = artifact.actions.filter((action) => action.kind === "put").length;
  const deletes = artifact.actions.filter((action) => action.kind === "delete").length;
  if (artifact.ceilings.puts !== puts || artifact.ceilings.deletes !== deletes) {
    throw new CodedResourceError("plan_drift", "plan artifact action counts do not match its ceilings");
  }
  if (artifact.resources.reduce((n, r) => n + r.deletes, 0) !== deletes) {
    throw new CodedResourceError("plan_drift", "plan artifact resource deletes do not match its actions");
  }
  if (artifact.resources.reduce((n, r) => n + r.puts, 0) !== puts) {
    throw new CodedResourceError("plan_drift", "plan artifact resource puts do not match its actions");
  }
  if (artifact.kind === "publish" && (artifact.listed !== null || artifact.listedDigest !== null || artifact.policy !== null)) {
    throw new CodedResourceError("plan_drift", "publish plan artifact carries reconcile fields");
  }
  if (artifact.kind === "reconcile" && (typeof artifact.listed !== "number" || typeof artifact.listedDigest !== "string")) {
    throw new CodedResourceError("plan_drift", "reconcile plan artifact is missing its listing digest");
  }
  return artifact;
}

export interface LoadedPlanArtifact {
  artifact: ResourcePlanArtifact;
  /** SHA-256 over the exact file bytes. */
  sha256: string;
}

/**
 * Reads, size-caps, hashes, parses, and validates a plan artifact. The file
 * must be canonical: its bytes must hash to the same value as a freshly
 * canonicalized serialization, so a semantically identical but re-keyed or
 * reformatted file (an edited plan) is refused.
 */
export async function readPlanArtifact(path: string): Promise<LoadedPlanArtifact> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    throw new CodedResourceError("plan_drift", "plan artifact cannot be read");
  }
  if (bytes.byteLength === 0 || bytes.byteLength > PLAN_ARTIFACT_MAX_BYTES) {
    throw new CodedResourceError("plan_drift", "plan artifact size is outside the allowed bound");
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new CodedResourceError("plan_drift", "plan artifact is not valid JSON");
  }
  const artifact = validatePlanArtifact(parsed);
  if (planArtifactSha256(artifact) !== sha256) {
    throw new CodedResourceError("plan_drift", "plan artifact is not in canonical form");
  }
  return { artifact, sha256 };
}

/** Everything the executor re-derives from the live process and its CLI. */
export interface PlanLiveIdentity {
  kind: "publish" | "reconcile";
  family: ResourceCommandFamily;
  configVersion: string;
  pinSetVersion: string;
  distHash: string;
  target: ResourceTarget;
  app: string;
  publisherPk: string;
  homeserverPk: string;
  limit: number;
  fetch: boolean;
  policy: ReconcilePolicy | null;
  retired: readonly string[];
  allowMassDelete: boolean;
  allowHighDeleteRatio: boolean;
  tagger: { id: "rules" | "model"; model: string | null };
  /** Ledger-derived first-write state at execution time, when a pool exists. */
  firstProductionWrite?: boolean;
}

function drift(field: string): never {
  throw new CodedResourceError("plan_drift", `plan artifact does not match this run: ${field}`);
}

/**
 * Domain binding: a plan from another family, tagger, config version, dist
 * build, target, publisher, pin set, limit, or override set MUST refuse even
 * when its actions are byte-identical, because the hash an operator confirmed
 * only ever commits to one exact context.
 */
export function assertPlanArtifactLive(artifact: ResourcePlanArtifact, live: PlanLiveIdentity): void {
  if (artifact.kind !== live.kind) drift("kind");
  if (artifact.family !== live.family) drift("family");
  if (artifact.configVersion !== live.configVersion) drift("config_version");
  if (artifact.pinSetVersion !== live.pinSetVersion || live.pinSetVersion !== RESOURCE_PIN_SET_VERSION) {
    drift("pin_set_version");
  }
  if (artifact.distHash !== live.distHash) drift("dist_hash");
  if (artifact.target !== live.target) drift("target");
  if (artifact.app !== live.app) drift("app");
  if (artifact.publisherPk !== live.publisherPk) drift("publisher_pk");
  if (artifact.homeserverPk !== live.homeserverPk) drift("homeserver_pk");
  if (artifact.limit !== live.limit) drift("limit");
  if (artifact.fetch !== live.fetch) drift("fetch");
  if (artifact.policy !== live.policy) drift("policy");
  if ([...artifact.retired].sort().join("\n") !== [...live.retired].sort().join("\n")) drift("retired");
  if (artifact.allowMassDelete !== live.allowMassDelete) drift("allow_mass_delete");
  if (artifact.allowHighDeleteRatio !== live.allowHighDeleteRatio) drift("allow_high_delete_ratio");
  if (artifact.tagger.id !== live.tagger.id || artifact.tagger.model !== live.tagger.model) drift("tagger");
  if (live.firstProductionWrite !== undefined && artifact.firstProductionWrite !== live.firstProductionWrite) {
    drift("first_production_write");
  }
}

/**
 * Freshness from a trusted clock. A ledger-backed executor passes the
 * database's `now()` (its own run row's `started_at`) and the artifact's
 * `plannedAt` is the planner row's DB `started_at` — the one-hour window is
 * enforced between two DB values, so neither process's wall clock can age or
 * rejuvenate a plan. There is no future tolerance: with one shared clock a
 * plan dated ahead of "now" is forged, not skewed.
 */
export function assertPlanArtifactFresh(artifact: ResourcePlanArtifact, nowMs: number): void {
  const plannedMs = Date.parse(artifact.plannedAt);
  if (!Number.isFinite(plannedMs)) drift("planned_at");
  if (plannedMs > nowMs) {
    throw new CodedResourceError("plan_drift", "plan artifact is dated in the future");
  }
  if (nowMs - plannedMs > PLAN_ARTIFACT_MAX_AGE_MS) {
    throw new CodedResourceError("plan_drift", "plan artifact is stale; plan again and re-confirm");
  }
}

/**
 * Delete ceilings re-evaluated from the artifact itself, before any write:
 * the run ceiling min(50, floor(20% of listed)), the 50%-per-resource ratio,
 * and the unbypassable empty-desired-set guard. Returns violation kinds.
 */
export function artifactDeleteCeilingViolations(artifact: ResourcePlanArtifact): string[] {
  if (artifact.kind !== "reconcile" || artifact.target !== "production" || artifact.policy !== "full") return [];
  const violations: string[] = [];
  if (artifact.resources.some((r) => r.deletes > 0 && r.keep.length + r.puts === 0)) {
    violations.push("empty_desired_set");
  }
  const ceiling = productionFullDeleteCeiling(artifact.listed ?? 0);
  if (artifact.ceilings.deletes > ceiling && !artifact.allowMassDelete) violations.push("run_ceiling");
  if (
    artifact.resources.some((r) => {
      const existing = r.keep.length + r.protected.length + r.deletes;
      return existing > 0 && r.deletes > PRODUCTION_PER_RESOURCE_DELETE_RATIO * existing;
    }) &&
    !artifact.allowHighDeleteRatio
  ) {
    violations.push("per_resource_ratio");
  }
  return violations;
}

/** Refuses to execute a plan whose ceilings do not hold under its own overrides. */
export function assertArtifactDeleteCeilings(artifact: ResourcePlanArtifact): void {
  if (artifact.ceilings.violations.length > 0) {
    throw new CodedResourceError(
      "plan_drift",
      `plan artifact recorded ceiling violations: ${artifact.ceilings.violations.join(", ")}`,
    );
  }
  const violations = artifactDeleteCeilingViolations(artifact);
  if (violations.length > 0) {
    throw new CodedResourceError("plan_drift", `production full reconcile refused: ${violations.join(", ")}`);
  }
}
