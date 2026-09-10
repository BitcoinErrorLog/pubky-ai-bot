import { PubkyAppTag, PubkySpecsBuilder, getValidationLimits } from "pubky-app-specs";
import { createHash } from "node:crypto";
import type { Config } from "./config.js";
import { RESOURCE_RECORD_MAX, type ExternalResource } from "./external-resources.js";
import { RESOURCE_LABELS_PER_RESOURCE_MAX } from "./resource-classify.js";
import { isValidOpenTagLabel } from "./bot-kit/tags/policy.js";
import type { Transport } from "./homeserver.js";
import {
  assertOutboundClean,
  assertTargetHomeserverPk,
  assertTargetResourceHomeserverHost,
} from "./outbound-gate.js";
import { DEFAULT_RESOURCE_APP, resourceTargetProfile, type ResourceTarget } from "./resource-target-profile.js";
import { CodedResourceError, resourceErrorCode, type ResourceErrorCode } from "./resource-error-code.js";
import { normalizeUri, resourceIdentity } from "./resource-identity.js";
import { httpUrlRejectReason } from "./resource-url-safety.js";
import { PUBKY_POST_ID_RE } from "./bot-kit/crockford.js";

export { DEFAULT_RESOURCE_APP } from "./resource-target-profile.js";

/** Hard cap on PUTs in one publish run: hard record cap × labels per resource. */
export const RESOURCE_WRITE_MAX = RESOURCE_RECORD_MAX * RESOURCE_LABELS_PER_RESOURCE_MAX;
/** Hard cap on deletes in one reconcile run: hard record cap × labels per resource. */
export const RESOURCE_DELETE_MAX = RESOURCE_RECORD_MAX * RESOURCE_LABELS_PER_RESOURCE_MAX;

const PUBKY_APP = "pubky.app";
const PUBKY_POST_URI = new RegExp(`^pubky://[a-z0-9]{52}/pub/pubky\\.app/posts/${PUBKY_POST_ID_RE.source.slice(1, -1)}$`);

export function isPublishableResourceUri(uri: string): boolean {
  return uri.startsWith("pubky://") ? PUBKY_POST_URI.test(uri) : httpUrlRejectReason(uri) === null;
}

function assertResourceTargetAllowed(resource: ExternalResource, normalizedUri: string): void {
  if (normalizedUri.startsWith("pubky://") && resource.provenance.source !== "pubky-posts") {
    throw new Error("Pubky post targets are allowed only for source pubky-posts");
  }
  if (!isPublishableResourceUri(normalizedUri)) {
    throw new Error("resource URI is not an allowed HTTP URL or Pubky post URI");
  }
}

/**
 * App-name rules from pubky-app-specs `TagPath::parse` / `try_parse_pubky_path`:
 * a single path segment after `/pub/`, nonempty, and not `pubky.app`
 * (`APP_PATH` = `pubky.app/`). Specs tests accept `eventky.app` and `mapky`.
 */
export function assertResourceAppName(app: string): string {
  const name = app.trim();
  if (!name) throw new Error("JEB_RESOURCE_APP must be a nonempty app path segment");
  if (name === PUBKY_APP) throw new Error("JEB_RESOURCE_APP must not be pubky.app");
  if (name.includes("/") || name.includes("\\") || name.includes(" ")) {
    throw new Error("JEB_RESOURCE_APP must be a single path segment");
  }
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(name)) {
    throw new Error("JEB_RESOURCE_APP is not a valid app-name path segment");
  }
  return name;
}

/**
 * Homeserver path for one universal tag. Mirrors
 * `pubky://<user>/pub/<app>/tags/<tag_id>` minus the pubky origin
 * (`tag.rs` TagPath: segments `tags` + nonempty id, app ≠ pubky.app).
 */
export function resourceTagHomeserverPath(app: string, tagId: string): string {
  const name = assertResourceAppName(app);
  if (!tagId) throw new Error("tag id is empty");
  return `/pub/${name}/tags/${tagId}`;
}

/** True when a homeserver path is a universal tag path, not a pubky.app tag. */
export function isUniversalTagHomeserverPath(path: string): boolean {
  const match = path.match(/^\/pub\/([^/]+)\/tags\/([^/]+)$/);
  if (!match) return false;
  const app = match[1]!;
  const tagId = match[2]!;
  return app.length > 0 && app !== PUBKY_APP && tagId.length > 0;
}

export interface ResourceTagBody {
  uri: string;
  label: string;
  created_at: number;
}

export interface ResourceTagWrite {
  normalizedUri: string;
  resourceIdentity: string;
  label: string;
  tagPath: string;
  tagId: string;
}

export interface ResourcePublishManifest {
  configVersion: string;
  app: string;
  target: ResourceTarget;
  /** False for a dry run: the plan below was computed and nothing was written. */
  executed: boolean;
  /** Canonical write plan and its hash, emitted for dry runs and executions alike. */
  plan: ResourcePublishPlan;
  planSha256: string;
  written: number;
  skipped_existing: number;
  failed: number;
  writes: ResourceTagWrite[];
  // `error` is a bounded code: a thrown SDK or homeserver error can carry a
  // request URL or a header, and this row is printed and persisted.
  failures: Array<{ tagPath: string; label: string; normalizedUri: string; error: ResourceErrorCode }>;
}

export interface ResourcePublishPlanItem {
  resourceIdentity: string;
  normalizedUri: string;
  label: string;
  tagPath: string;
  tagId: string;
}

export interface ResourcePublishPlan {
  items: ResourcePublishPlanItem[];
  rejected: Array<{ normalizedUri: string; label: string; reason: string }>;
}

function createdAtNumber(value: unknown): number {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value);
  throw new Error("tag created_at is missing");
}

export function asTagBody(json: unknown): ResourceTagBody | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const rec = json as Record<string, unknown>;
  if (typeof rec.uri !== "string" || typeof rec.label !== "string") return null;
  try {
    return { uri: rec.uri, label: rec.label, created_at: createdAtNumber(rec.created_at) };
  } catch {
    return null;
  }
}

export function canonicalTagJson(body: ResourceTagBody): string {
  return JSON.stringify({ uri: body.uri, label: body.label, created_at: body.created_at });
}

function isMissingOnHomeserver(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /404/.test(msg) || /not found/i.test(msg) || /directory not found/i.test(msg);
}

/**
 * The HTTP status a transport error surfaced, if any. SDK request errors
 * carry it as `data.statusCode`; test and adapter errors may carry `status`
 * or `statusCode` directly. Message text is never inspected: "not found" in
 * a 500 body proves nothing about absence.
 */
export function transportErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const rec = error as { status?: unknown; statusCode?: unknown; data?: unknown };
  for (const value of [rec.status, rec.statusCode]) {
    if (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599) return value;
  }
  const data = rec.data;
  if (data && typeof data === "object") {
    const value = (data as { statusCode?: unknown }).statusCode;
    if (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599) return value;
  }
  return undefined;
}

/**
 * DELETE verification. Absence is proven only by a literal 404 status from
 * the transport; a null body, any other status, or error text that merely
 * mentions "not found" is a readback failure, never a verification.
 */
export async function assertDeletedFromHomeserver(client: Transport, path: string): Promise<void> {
  let json: unknown;
  try {
    json = await client.getJson(path);
  } catch (error) {
    if (transportErrorStatus(error) === 404) return;
    throw new CodedResourceError("readback_failed", `DELETE readback failed at ${path}`);
  }
  if (json == null) throw new CodedResourceError("readback_failed", `DELETE readback returned a null body at ${path}`);
  throw new CodedResourceError("readback_failed", `DELETE readback still present at ${path}`);
}

function specsLabelMax(): number {
  const limits = getValidationLimits() as { tagLabelMaxLength?: number; tagLabelMinLength?: number };
  return typeof limits.tagLabelMaxLength === "number" && limits.tagLabelMaxLength > 0 ? limits.tagLabelMaxLength : 20;
}

function specsLabelMin(): number {
  const limits = getValidationLimits() as { tagLabelMinLength?: number };
  return typeof limits.tagLabelMinLength === "number" && limits.tagLabelMinLength > 0 ? limits.tagLabelMinLength : 1;
}

/** Specs `validate_tag_label` plus Jeb open-tag style. */
export function assertPublishableTagLabel(label: string): void {
  const min = specsLabelMin();
  const max = specsLabelMax();
  const chars = [...label].length;
  if (chars < min || chars > max) throw new Error(`tag label length must be ${min}..${max}`);
  if (/\s/.test(label)) throw new Error("tag label contains whitespace");
  if (!isValidOpenTagLabel(label)) throw new Error(`invalid tag label: ${JSON.stringify(label)}`);
}

/**
 * Build one tag using pubky-app-specs `createTag` (id = Crockford-base32 of the
 * first half of BLAKE3(`${uri}:${label}`)) then rewrite the path off `pubky.app`.
 */
export function buildUniversalResourceTag(
  botPk: string,
  app: string,
  normalizedUri: string,
  label: string,
): { path: string; tagId: string; body: ResourceTagBody } {
  assertPublishableTagLabel(label);
  const specs = new PubkySpecsBuilder(botPk);
  const { tag, meta } = specs.createTag(normalizedUri, label);
  const raw = tag.toJson() as { uri?: string; label?: string; created_at?: unknown };
  const body: ResourceTagBody = {
    uri: normalizedUri,
    label: typeof raw.label === "string" ? raw.label : label,
    created_at: createdAtNumber(raw.created_at),
  };
  PubkyAppTag.fromJson(body);
  const path = resourceTagHomeserverPath(app, meta.id);
  if (!isUniversalTagHomeserverPath(path)) {
    throw new Error("refusing to write a non-universal tag path");
  }
  return { path, tagId: meta.id, body };
}

export type ReconcilePolicy = "retired" | "full";

/**
 * Pin check for one target. Production additionally requires host evidence:
 * the SDK does not currently expose the authenticated storage endpoint, so a
 * transport that cannot say which host it reached is refused rather than
 * trusted on the public key alone.
 */
export function assertTargetPins(
  target: ResourceTarget,
  evidence: { resolvedHomeserverPk?: string; resolvedHomeserverHost?: string },
): void {
  const pk = evidence.resolvedHomeserverPk;
  if (!pk) throw new Error("resource egress refused: session homeserver public key is missing");
  assertTargetHomeserverPk(target, pk);
  if (evidence.resolvedHomeserverHost !== undefined) {
    assertTargetResourceHomeserverHost(target, evidence.resolvedHomeserverHost);
  } else if (target === "production") {
    throw new Error("resource egress refused: production requires resolved homeserver host evidence");
  }
}

export type DeletePreconditionReason =
  | "mode"
  | "allowlist"
  | "path"
  | "body"
  | "identity"
  | "recomputed_path"
  | "desired"
  | "retired"
  | "approved_body";

export type DeletePreconditionContext = {
  mode: "publish" | "reconcile";
  target: ResourceTarget;
  /** Publisher this target pins: the pilot on staging, Jeb on production. */
  expectedPublisherPk: string;
  botPk: string;
  resolvedHomeserverPk?: string;
  resolvedHomeserverHost?: string;
  path: string;
  listedPaths: ReadonlySet<string>;
  approvedDeletes: ReadonlyMap<string, ResourceTagBody>;
  body: unknown;
  resourceIdentity: string;
  acceptedUris: ReadonlyMap<string, string>;
  desiredByResource: ReadonlyMap<string, ReadonlySet<string>>;
  retiredLabels: ReadonlySet<string>;
  policy: ReconcilePolicy;
  app: string;
};

export function deletePrecondition(ctx: DeletePreconditionContext): { ok: true } | { ok: false; reason: DeletePreconditionReason } {
  if (ctx.mode !== "reconcile" || ctx.expectedPublisherPk !== ctx.botPk) return { ok: false, reason: "mode" };
  try {
    const profile = resourceTargetProfile(ctx.target);
    if (profile.publisherPk !== ctx.botPk) return { ok: false, reason: "mode" };
    assertTargetPins(ctx.target, ctx);
  } catch {
    return { ok: false, reason: "mode" };
  }
  if (!ctx.listedPaths.has(ctx.path) || !ctx.approvedDeletes.has(ctx.path)) return { ok: false, reason: "allowlist" };
  let app: string;
  try {
    app = assertResourceAppName(ctx.app);
  } catch {
    return { ok: false, reason: "path" };
  }
  if (!isUniversalTagHomeserverPath(ctx.path) || ctx.path !== resourceTagHomeserverPath(app, ctx.path.split("/").pop() ?? "")) {
    return { ok: false, reason: "path" };
  }
  const body = asTagBody(ctx.body);
  if (!body) return { ok: false, reason: "body" };
  let normalized: string;
  try {
    normalized = normalizeUri(body.uri);
    assertPublishableTagLabel(body.label);
  } catch {
    return { ok: false, reason: "body" };
  }
  if (ctx.acceptedUris.get(ctx.resourceIdentity) !== normalized) return { ok: false, reason: "identity" };
  let rebuilt: { path: string; tagId: string; body: ResourceTagBody };
  try {
    rebuilt = buildUniversalResourceTag(ctx.botPk, ctx.app, normalized, body.label);
  } catch {
    return { ok: false, reason: "recomputed_path" };
  }
  if (rebuilt.path !== ctx.path) return { ok: false, reason: "recomputed_path" };
  let bodyResourceId: string;
  try {
    bodyResourceId = resourceIdentity(normalizeUri(body.uri));
  } catch {
    return { ok: false, reason: "identity" };
  }
  if (ctx.desiredByResource.get(bodyResourceId)?.has(body.label)) return { ok: false, reason: "desired" };
  if (ctx.policy !== "full" && !ctx.retiredLabels.has(body.label)) return { ok: false, reason: "retired" };
  const approved = ctx.approvedDeletes.get(ctx.path);
  if (!approved || canonicalTagJson(approved) !== canonicalTagJson(body)) return { ok: false, reason: "approved_body" };
  return { ok: true };
}

type GatedReconcileOptions = {
  mode: "publish" | "reconcile";
  target: ResourceTarget;
  app?: string;
  expectedPublisherPk?: string;
  listedPaths?: ReadonlySet<string>;
  approvedDeletes?: ReadonlyMap<string, ResourceTagBody>;
  acceptedUris?: ReadonlyMap<string, string>;
  desiredByResource?: ReadonlyMap<string, ReadonlySet<string>>;
  retiredLabels?: ReadonlySet<string>;
  policy?: ReconcilePolicy;
};

export function gatedResourceTransport(inner: Transport, options: GatedReconcileOptions): Transport {
  let executedPuts = 0;
  const gate = (): void => {
    assertTargetPins(options.target, inner);
  };
  gate();
  return {
    botPk: inner.botPk,
    resolvedHomeserverPk: inner.resolvedHomeserverPk,
    resolvedHomeserverHost: inner.resolvedHomeserverHost,
    async putJson(path, json) {
      gate();
      if (!isUniversalTagHomeserverPath(path)) {
        throw new Error("refusing PUT outside universal tag path");
      }
      const body = asTagBody(json);
      if (!body) throw new Error("tag body must be { uri, label, created_at }");
      if (!isPublishableResourceUri(body.uri)) throw new Error("resource URI is not an allowed HTTP URL or Pubky post URI");
      assertOutboundClean(canonicalTagJson(body));
      if (executedPuts >= RESOURCE_WRITE_MAX) throw new Error(`resource PUT execution cap exceeded; max is ${RESOURCE_WRITE_MAX}`);
      executedPuts += 1;
      await inner.putJson(path, body);
    },
    async putBytes(): Promise<void> {
      throw new Error("gated resource transport does not allow putBytes");
    },
    async getJson(path) {
      gate();
      return inner.getJson(path);
    },
    async deleteJson(): Promise<void> {
      if (options.mode !== "reconcile") throw new Error("gated resource transport does not allow deleteJson");
      throw new Error("deleteJson requires reconcile context");
    },
    async listPosts(): Promise<Array<{ parent?: string; uri: string }>> {
      throw new Error("gated resource transport does not allow listPosts");
    },
    async reauth() {
      gate();
      await inner.reauth();
      gate();
    },
  };
}

export function requireReconcileTransport(inner: Transport, options: GatedReconcileOptions): Transport {
  const base = gatedResourceTransport(inner, options);
  const listedPaths = options.listedPaths ?? new Set<string>();
  const approvedDeletes = options.approvedDeletes ?? new Map<string, ResourceTagBody>();
  const acceptedUris = options.acceptedUris ?? new Map<string, string>();
  const desiredByResource = options.desiredByResource ?? new Map<string, ReadonlySet<string>>();
  const retiredLabels = options.retiredLabels ?? new Set<string>();
  let executedDeletes = 0;
  return {
    ...base,
    async deleteJson(path) {
      gateReconcile(inner, options);
      if (!listedPaths.has(path) || !approvedDeletes.has(path)) throw new Error("delete path is not in the immutable allowlist");
      const current = await inner.getJson(path);
      const identity = [...acceptedUris.keys()].find((id) => {
        const body = asTagBody(current);
        if (!body) return false;
        try { return resourceIdentity(normalizeUri(body.uri)) === id; } catch { return false; }
      }) ?? "";
      const result = deletePrecondition({
        mode: "reconcile",
        target: options.target,
        expectedPublisherPk: options.expectedPublisherPk ?? "",
        botPk: inner.botPk,
        resolvedHomeserverPk: inner.resolvedHomeserverPk,
        resolvedHomeserverHost: inner.resolvedHomeserverHost,
        path,
        listedPaths,
        approvedDeletes,
        body: current,
        resourceIdentity: identity,
        acceptedUris,
        desiredByResource,
        retiredLabels,
        policy: options.policy ?? "retired",
        app: options.app ?? DEFAULT_RESOURCE_APP,
      });
      if (!result.ok) throw new Error(`delete precondition failed: ${result.reason}`);
      if (executedDeletes >= RESOURCE_DELETE_MAX) throw new Error(`resource DELETE execution cap exceeded; max is ${RESOURCE_DELETE_MAX}`);
      executedDeletes += 1;
      await inner.deleteJson(path);
    },
  };
}

function gateReconcile(inner: Transport, options: GatedReconcileOptions): void {
  assertTargetPins(options.target, inner);
  if (inner.botPk !== options.expectedPublisherPk) throw new Error("reconcile publisher public key mismatch");
  if (inner.botPk !== resourceTargetProfile(options.target).publisherPk) {
    throw new Error("reconcile publisher is not the pinned publisher for this target");
  }
}

export type ResourceReconcileAction = { label: string; path: string; body?: ResourceTagBody; reason?: string };
export type ResourceReconcilePlan = {
  resources: Array<{
    resource_id: string;
    uri: string;
    keep: ResourceReconcileAction[];
    put: ResourceReconcileAction[];
    delete: ResourceReconcileAction[];
    protected: ResourceReconcileAction[];
  }>;
  put: ResourceReconcileAction[];
  delete: ResourceReconcileAction[];
  listed: number;
};

function semanticPlan(plan: ResourceReconcilePlan): string {
  const action = (item: ResourceReconcileAction, kind: string) => ({
    label: item.label,
    path: item.path,
    ...(item.reason ? { reason: item.reason } : {}),
    ...(item.body ? { body: kind === "put"
      ? { uri: item.body.uri, label: item.body.label }
      : { uri: item.body.uri, label: item.body.label, created_at: item.body.created_at } } : {}),
  });
  return JSON.stringify({
    resources: plan.resources.map((r) => ({
      ...r,
      keep: [...r.keep].sort(actionSort).map((item) => action(item, "keep")),
      put: [...r.put].sort(actionSort).map((item) => action(item, "put")),
      delete: [...r.delete].sort(actionSort).map((item) => action(item, "delete")),
      protected: [...r.protected].sort(actionSort).map((item) => action(item, "protected")),
    })).sort((a, b) => a.resource_id.localeCompare(b.resource_id)),
    put: [...plan.put].sort(actionSort).map((item) => action(item, "put")),
    delete: [...plan.delete].sort(actionSort).map((item) => action(item, "delete")),
    listed: plan.listed,
  });
}

function actionSort(a: ResourceReconcileAction, b: ResourceReconcileAction): number {
  return a.label.localeCompare(b.label) || a.path.localeCompare(b.path);
}

/** Ceiling on deletes for one production `full` run: half the invocation cap, or 20% of inventory. */
export function productionFullDeleteCeiling(listed: number): number {
  return Math.min(50, Math.floor(0.2 * listed));
}

/** Most of one resource's existing labels a `full` run may remove. */
export const PRODUCTION_PER_RESOURCE_DELETE_RATIO = 0.5;

export type DeleteCeilingViolation =
  | { kind: "empty_desired_set"; resourceIds: string[] }
  | { kind: "run_ceiling"; deletes: number; ceiling: number; listed: number }
  | { kind: "per_resource_ratio"; resourceIds: string[] };

export interface DeleteOverrides {
  allowMassDelete: boolean;
  allowHighDeleteRatio: boolean;
}

/**
 * Production `full` guards. The empty-desired-set guard is unconditional: no
 * override can authorize deleting every label a resource has.
 */
export function productionFullDeleteViolations(
  plan: ResourceReconcilePlan,
  overrides: DeleteOverrides,
): DeleteCeilingViolation[] {
  const violations: DeleteCeilingViolation[] = [];
  const emptyDesired = plan.resources
    .filter((resource) => resource.delete.length > 0 && resource.keep.length + resource.put.length === 0)
    .map((resource) => resource.resource_id);
  if (emptyDesired.length > 0) violations.push({ kind: "empty_desired_set", resourceIds: emptyDesired });
  const ceiling = productionFullDeleteCeiling(plan.listed);
  if (plan.delete.length > ceiling && !overrides.allowMassDelete) {
    violations.push({ kind: "run_ceiling", deletes: plan.delete.length, ceiling, listed: plan.listed });
  }
  const highRatio = plan.resources
    .filter((resource) => {
      // Existing labels for this resource are the ones already on the
      // homeserver: kept, protected, or slated for deletion. Puts are new.
      const existing = resource.keep.length + resource.protected.length + resource.delete.length;
      return existing > 0 && resource.delete.length > PRODUCTION_PER_RESOURCE_DELETE_RATIO * existing;
    })
    .map((resource) => resource.resource_id);
  if (highRatio.length > 0 && !overrides.allowHighDeleteRatio) {
    violations.push({ kind: "per_resource_ratio", resourceIds: highRatio });
  }
  return violations;
}

export function reconcilePlanSha256(
  plan: ResourceReconcilePlan,
  cfg: Pick<ReconcileConfig, "policy" | "retired" | "resourceConfigVersion" | "resourceApp" | "resourceTarget" | "expectedPublisherPk"> &
    DeleteOverrides & { botPk: string; resolvedHomeserverPk?: string; resolvedHomeserverHost?: string },
): string {
  const entries = plan.resources.flatMap((resource) => [
    ...resource.keep.map((action) => ["keep", action] as const),
    ...resource.put.map((action) => ["put", action] as const),
    ...resource.delete.map((action) => ["delete", action] as const),
    ...resource.protected.map((action) => ["protected", action] as const),
  ]).sort((a, b) => a[0].localeCompare(b[0]) || a[1].path.localeCompare(b[1].path));
  const preimage = {
    entries: entries.map(([action, item]) => ({
      action,
      path: item.path,
      label: item.label,
      ...(item.reason ? { reason: item.reason } : {}),
      ...(item.body ? { body: action === "put"
        ? { uri: item.body.uri, label: item.body.label }
        : { uri: item.body.uri, label: item.body.label, created_at: item.body.created_at } } : {}),
    })),
    policy: cfg.policy,
    retired: [...cfg.retired].sort(),
    botPk: cfg.botPk,
    resolvedHomeserverPk: cfg.resolvedHomeserverPk ?? null,
    resolvedHomeserverHost: cfg.resolvedHomeserverHost ?? null,
    configVersion: cfg.resourceConfigVersion,
    app: cfg.resourceApp,
    listed: plan.listed,
    target: cfg.resourceTarget,
    expectedPublisherPk: cfg.expectedPublisherPk,
    pinSetVersion: resourceTargetProfile(cfg.resourceTarget).pinSetVersion,
    allowMassDelete: cfg.allowMassDelete,
    allowHighDeleteRatio: cfg.allowHighDeleteRatio,
    deleteCeiling: productionFullDeleteCeiling(plan.listed),
    perResourceDeleteRatio: PRODUCTION_PER_RESOURCE_DELETE_RATIO,
  };
  return createHash("sha256").update(JSON.stringify(preimage)).digest("hex");
}

function bodyForPath(client: Transport, path: string): Promise<unknown> {
  return client.getJson(path);
}

export async function makeReconcilePlan(
  accepted: readonly ExternalResource[],
  cfg: ReconcileConfig,
  client: Transport,
): Promise<{
  plan: ResourceReconcilePlan;
  listedPaths: Set<string>;
  approved: Map<string, ResourceTagBody>;
  desiredByResource: Map<string, Set<string>>;
}> {
  const prefix = `/pub/${cfg.resourceApp}/tags/`;
  if (!client.listJsonPaths) throw new Error("reconcile transport does not support session listing");
  const acceptedMap = new Map<string, string>();
  const desired = new Map<string, Set<string>>();
  for (const resource of accepted) {
    const normalized = normalizeUri(resource.canonicalValue);
    const id = resourceIdentity(normalized);
    if (resource.identity !== id) throw new Error(`accepted resource identity mismatch for ${normalized}`);
    if (acceptedMap.has(id)) throw new Error("duplicate accepted resource identity");
    acceptedMap.set(id, normalized);
    desired.set(id, new Set(resource.labels));
  }
  const paths = await client.listJsonPaths(prefix);
  const listedPaths = new Set(paths);
  if (listedPaths.size !== paths.length || paths.some((p) => p !== `${prefix}${p.slice(prefix.length)}` || !p.startsWith(prefix))) {
    throw new Error("invalid homeserver listing");
  }
  const byPath = new Map<string, unknown>();
  for (const path of paths) {
    try { byPath.set(path, await bodyForPath(client, path)); }
    catch { throw new Error("homeserver listing snapshot changed during GET"); }
  }
  const resources = new Map<string, ResourceReconcilePlan["resources"][number]>();
  const put: ResourceReconcileAction[] = [];
  const del: ResourceReconcileAction[] = [];
  const approved = new Map<string, ResourceTagBody>();
  for (const resource of accepted) {
    const normalized = normalizeUri(resource.canonicalValue);
    const id = resourceIdentity(normalized);
    assertResourceTargetAllowed(resource, normalized);
    const row = { resource_id: id, uri: normalized, keep: [], put: [], delete: [], protected: [] } as ResourceReconcilePlan["resources"][number];
    resources.set(id, row);
    for (const label of resource.labels) {
      const built = buildUniversalResourceTag(client.botPk, cfg.resourceApp, normalized, label);
      const existing = byPath.get(built.path);
      if (existing === undefined) {
        const action = { label, path: built.path, body: built.body };
        row.put.push(action); put.push(action);
      } else {
        const existingBody = asTagBody(existing);
        if (!existingBody) throw new Error("malformed tag body");
        if (existingBody.uri === built.body.uri && existingBody.label === built.body.label) {
          row.keep.push({ label, path: built.path, body: existingBody });
        } else {
          throw new Error("tag path already holds a different uri/label");
        }
      }
    }
  }
  for (const [path, raw] of byPath) {
    const body = asTagBody(raw);
    if (!body) throw new Error("malformed tag body");
    const normalized = (() => { try { return normalizeUri(body.uri); } catch { return null; } })();
    if (!normalized) throw new Error("malformed tag uri");
    const id = resourceIdentity(normalized);
    const row = resources.get(id);
    if (!row) continue;
    const expected = buildUniversalResourceTag(client.botPk, cfg.resourceApp, normalized, body.label);
    if (expected.path !== path) throw new Error("tag body does not derive listed path");
    if (desired.get(id)?.has(body.label)) continue;
    if (cfg.policy === "retired" && !cfg.retired.has(body.label)) {
      row.protected.push({ label: body.label, path, reason: "not retired" });
      continue;
    }
    const action = { label: body.label, path, body };
    row.delete.push(action); del.push(action); approved.set(path, body);
  }
  if (put.length > RESOURCE_WRITE_MAX) throw new Error(`reconcile run would issue ${put.length} writes; max is ${RESOURCE_WRITE_MAX}`);
  if (del.length > RESOURCE_DELETE_MAX) throw new Error(`reconcile run would issue ${del.length} deletes; max is ${RESOURCE_DELETE_MAX}`);
  return {
    plan: { resources: [...resources.values()], put, delete: del, listed: paths.length },
    listedPaths,
    approved,
    desiredByResource: desired,
  };
}

export type ReconcileConfig = Pick<Config, "resourceTarget" | "resourceApp" | "resourceConfigVersion"> &
  Partial<DeleteOverrides> & {
    expectedPublisherPk: string;
    policy: ReconcilePolicy;
    retired: ReadonlySet<string>;
    execute: boolean;
    confirmPlan?: string;
  };

export async function reconcileResourceTags(
  accepted: readonly ExternalResource[],
  cfg: ReconcileConfig,
  homeserverClient: Transport,
): Promise<{ plan: ResourceReconcilePlan; planSha256: string }> {
  const profile = resourceTargetProfile(cfg.resourceTarget);
  if (cfg.expectedPublisherPk !== profile.publisherPk) throw new Error("reconcile publisher pin constant/flag mismatch");
  if (homeserverClient.botPk !== cfg.expectedPublisherPk) throw new Error("reconcile publisher pin flag/session mismatch");
  assertTargetPins(cfg.resourceTarget, homeserverClient);
  const overrides: DeleteOverrides = {
    allowMassDelete: cfg.allowMassDelete === true,
    allowHighDeleteRatio: cfg.allowHighDeleteRatio === true,
  };
  const first = await makeReconcilePlan(accepted, cfg, homeserverClient);
  const hashContext = {
    policy: cfg.policy,
    retired: cfg.retired,
    resourceConfigVersion: cfg.resourceConfigVersion,
    resourceApp: cfg.resourceApp,
    resourceTarget: cfg.resourceTarget,
    expectedPublisherPk: cfg.expectedPublisherPk,
    ...overrides,
    botPk: homeserverClient.botPk,
    resolvedHomeserverPk: homeserverClient.resolvedHomeserverPk,
    resolvedHomeserverHost: homeserverClient.resolvedHomeserverHost,
  };
  const firstHash = reconcilePlanSha256(first.plan, hashContext);
  assertReconcileDeleteCeilings(first.plan, cfg, overrides);
  if (!cfg.execute) return { plan: first.plan, planSha256: firstHash };
  const second = await makeReconcilePlan(accepted, cfg, homeserverClient);
  if (semanticPlan(first.plan) !== semanticPlan(second.plan)) throw new Error("reconcile plan drift");
  const secondHash = reconcilePlanSha256(second.plan, hashContext);
  assertReconcileDeleteCeilings(second.plan, cfg, overrides);
  // Staging keeps its established full-only confirmation so the pilot workflow
  // is unchanged; every production reconcile is confirmed.
  if ((cfg.policy === "full" || cfg.resourceTarget === "production") && cfg.confirmPlan !== secondHash) {
    throw new Error(`${cfg.resourceTarget} ${cfg.policy} reconcile requires matching --confirm-plan`);
  }
  const acceptedUris = new Map(accepted.map((r) => [resourceIdentity(normalizeUri(r.canonicalValue)), normalizeUri(r.canonicalValue)]));
  const putClient = gatedResourceTransport(homeserverClient, { mode: "reconcile", target: cfg.resourceTarget });
  for (const action of second.plan.put) {
    const existing = await readExisting(homeserverClient, action.path);
    if (existing) {
      if (!action.body || existing.uri !== action.body.uri || existing.label !== action.body.label) {
        throw new Error("desired tag changed before PUT");
      }
      continue;
    }
    const putBody = action.body
      ? buildUniversalResourceTag(homeserverClient.botPk, cfg.resourceApp, action.body.uri, action.body.label).body
      : {};
    await putClient.putJson(action.path, putBody);
    const readback = await readExisting(homeserverClient, action.path);
    if (!readback || !action.body || readback.uri !== action.body.uri || readback.label !== action.body.label) {
      throw new Error(`PUT readback mismatch at ${action.path}`);
    }
  }
  const gated = requireReconcileTransport(homeserverClient, {
    mode: "reconcile", target: cfg.resourceTarget, app: cfg.resourceApp, expectedPublisherPk: cfg.expectedPublisherPk,
    listedPaths: second.listedPaths, approvedDeletes: second.approved,
    acceptedUris, desiredByResource: second.desiredByResource, retiredLabels: cfg.retired, policy: cfg.policy,
  });
  for (const action of [...second.plan.delete].sort(actionSort)) await gated.deleteJson(action.path);
  const verify = await makeReconcilePlan(accepted, cfg, homeserverClient);
  if (verify.plan.put.length || verify.plan.delete.length) throw new Error(`final desired-set mismatch: ${JSON.stringify(verify.plan)}`);
  return { plan: second.plan, planSha256: secondHash };
}

/** Production `full` ceilings, applied to both the planned and the replanned set. */
function assertReconcileDeleteCeilings(
  plan: ResourceReconcilePlan,
  cfg: Pick<ReconcileConfig, "policy" | "resourceTarget">,
  overrides: DeleteOverrides,
): void {
  if (cfg.resourceTarget !== "production" || cfg.policy !== "full") return;
  const violations = productionFullDeleteViolations(plan, overrides);
  if (violations.length > 0) {
    throw new Error(`production full reconcile refused: ${violations.map((v) => v.kind).join(", ")}`);
  }
}

export async function readExisting(client: Transport, path: string): Promise<ResourceTagBody | null> {
  try {
    const json = await client.getJson(path);
    if (json == null) return null;
    return asTagBody(json);
  } catch (err) {
    if (transportErrorStatus(err) === 404 || isMissingOnHomeserver(err)) return null;
    throw err;
  }
}

export type PublishConfig = Pick<Config, "resourceTarget" | "resourceMode" | "resourceApp" | "resourceConfigVersion"> & {
  expectedPublisherPk: string;
  /** Dry run unless explicitly executed: publish performs zero PUTs by default. */
  execute: boolean;
  confirmPlan?: string;
  /**
   * True when no production resource run with writes has been recorded yet.
   * The first production write must present a matching `--confirm-plan`.
   */
  firstProductionWrite?: boolean;
};

/**
 * Deterministic publish plan: the exact tag paths a run would write, in a
 * stable order, plus anything it refuses. Hashed so a dry run and its
 * execution can be proven to be the same run.
 */
export function publishPlanSha256(
  plan: ResourcePublishPlan,
  cfg: Pick<PublishConfig, "resourceTarget" | "resourceApp" | "resourceConfigVersion" | "expectedPublisherPk"> & {
    botPk: string;
    resolvedHomeserverPk?: string;
    resolvedHomeserverHost?: string;
  },
): string {
  const preimage = {
    items: plan.items.map((item) => ({
      resourceIdentity: item.resourceIdentity,
      normalizedUri: item.normalizedUri,
      label: item.label,
      tagPath: item.tagPath,
    })),
    rejected: plan.rejected,
    target: cfg.resourceTarget,
    app: cfg.resourceApp,
    configVersion: cfg.resourceConfigVersion,
    expectedPublisherPk: cfg.expectedPublisherPk,
    botPk: cfg.botPk,
    resolvedHomeserverPk: cfg.resolvedHomeserverPk ?? null,
    resolvedHomeserverHost: cfg.resolvedHomeserverHost ?? null,
    pinSetVersion: resourceTargetProfile(cfg.resourceTarget).pinSetVersion,
  };
  return createHash("sha256").update(JSON.stringify(preimage)).digest("hex");
}

export function makePublishPlan(accepted: readonly ExternalResource[], botPk: string, app: string): ResourcePublishPlan {
  const items: ResourcePublishPlanItem[] = [];
  const rejected: ResourcePublishPlan["rejected"] = [];
  for (const resource of accepted) {
    const normalized = normalizeUri(resource.canonicalValue);
    const identity = resourceIdentity(normalized);
    for (const label of resource.labels) {
      try {
        const built = buildUniversalResourceTag(botPk, app, normalized, label);
        assertResourceTargetAllowed(resource, normalized);
        items.push({
          resourceIdentity: identity,
          normalizedUri: normalized,
          label: built.body.label,
          tagPath: built.path,
          tagId: built.tagId,
        });
      } catch (err) {
        rejected.push({ normalizedUri: normalized, label, reason: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  items.sort((a, b) => a.tagPath.localeCompare(b.tagPath));
  rejected.sort((a, b) => a.normalizedUri.localeCompare(b.normalizedUri) || a.label.localeCompare(b.label));
  return { items, rejected };
}

export async function publishResourceTags(
  accepted: readonly ExternalResource[],
  cfg: PublishConfig,
  homeserverClient: Transport,
): Promise<ResourcePublishManifest> {
  if (cfg.resourceMode !== "publish") {
    throw new Error("publishResourceTags requires resourceMode=publish");
  }
  const profile = resourceTargetProfile(cfg.resourceTarget);
  if (cfg.resourceTarget !== "staging" && cfg.resourceTarget !== "production") {
    // Kept for parity with the historical refusal message.
    throw new Error("external-resource seeding is staging-only");
  }
  if (cfg.expectedPublisherPk !== profile.publisherPk) throw new Error("publish publisher pin constant/flag mismatch");
  if (homeserverClient.botPk !== cfg.expectedPublisherPk) throw new Error("publish publisher pin flag/session mismatch");
  const app = assertResourceAppName(cfg.resourceApp);
  if (`/pub/${app}/tags/` !== profile.tagCapabilityScope) {
    throw new Error("publish app is outside the pinned capability scope for this target");
  }
  const plannedWrites = accepted.reduce((n, resource) => n + resource.labels.length, 0);
  if (plannedWrites > RESOURCE_WRITE_MAX) {
    throw new Error(`resource publish run would issue ${plannedWrites} writes; max is ${RESOURCE_WRITE_MAX}`);
  }
  assertTargetPins(cfg.resourceTarget, homeserverClient);
  const plan = makePublishPlan(accepted, homeserverClient.botPk, app);
  const planSha256 = publishPlanSha256(plan, {
    resourceTarget: cfg.resourceTarget,
    resourceApp: cfg.resourceApp,
    resourceConfigVersion: cfg.resourceConfigVersion,
    expectedPublisherPk: cfg.expectedPublisherPk,
    botPk: homeserverClient.botPk,
    resolvedHomeserverPk: homeserverClient.resolvedHomeserverPk,
    resolvedHomeserverHost: homeserverClient.resolvedHomeserverHost,
  });

  const manifest: ResourcePublishManifest = {
    configVersion: cfg.resourceConfigVersion,
    app,
    target: cfg.resourceTarget,
    executed: false,
    plan,
    planSha256,
    written: 0,
    skipped_existing: 0,
    failed: 0,
    writes: [],
    failures: [],
  };
  if (!cfg.execute) return manifest;
  if (cfg.resourceTarget === "production" && cfg.firstProductionWrite !== false && cfg.confirmPlan !== planSha256) {
    throw new Error("first production publish requires matching --confirm-plan");
  }
  manifest.executed = true;
  const client = gatedResourceTransport(homeserverClient, { mode: "publish", target: cfg.resourceTarget });

  for (const resource of accepted) {
    const normalized = normalizeUri(resource.canonicalValue);
    const identity = resourceIdentity(normalized);
    for (const label of resource.labels) {
      let built: { path: string; tagId: string; body: ResourceTagBody };
      try {
        built = buildUniversalResourceTag(client.botPk, app, normalized, label);
        assertResourceTargetAllowed(resource, normalized);
      } catch (err) {
        manifest.failed += 1;
        manifest.failures.push({
          tagPath: "",
          label,
          normalizedUri: normalized,
          error: resourceErrorCode(err, "homeserver_conflict"),
        });
        continue;
      }
      try {
        const existing = await readExisting(client, built.path);
        if (existing && existing.uri === built.body.uri && existing.label === built.body.label) {
          manifest.skipped_existing += 1;
          continue;
        }
        if (existing) {
          throw new Error("tag path already holds a different uri/label");
        }
        await client.putJson(built.path, built.body);
        const readback = await readExisting(client, built.path);
        if (
          !readback ||
          canonicalTagJson(readback) !== canonicalTagJson(built.body)
        ) {
          throw new Error(`PUT readback mismatch at ${built.path}`);
        }
        manifest.written += 1;
        manifest.writes.push({
          normalizedUri: normalized,
          resourceIdentity: identity,
          label: built.body.label,
          tagPath: built.path,
          tagId: built.tagId,
        });
      } catch (err) {
        manifest.failed += 1;
        manifest.failures.push({
          tagPath: built.path,
          label,
          normalizedUri: normalized,
          error: resourceErrorCode(err, "homeserver_conflict"),
        });
      }
    }
  }
  return manifest;
}
