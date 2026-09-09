import { PubkyAppTag, PubkySpecsBuilder, getValidationLimits } from "pubky-app-specs";
import { createHash } from "node:crypto";
import type { Config } from "./config.js";
import { RESOURCE_RECORD_MAX, type ExternalResource } from "./external-resources.js";
import { RESOURCE_LABELS_PER_RESOURCE_MAX } from "./resource-classify.js";
import { isValidOpenTagLabel } from "./bot-kit/tags/policy.js";
import type { Transport } from "./homeserver.js";
import {
  assertOutboundClean,
  assertStagingHomeserverPk,
  assertStagingResourceHomeserverHost,
  RESOURCE_PILOT_BOT_PK,
  STAGING_HOMESERVER_HOST,
  STAGING_HOMESERVER_PK,
} from "./outbound-gate.js";
import { normalizeUri, resourceIdentity } from "./resource-identity.js";
import { httpUrlRejectReason } from "./resource-url-safety.js";

/** Default app segment for universal tags. Must not be `pubky.app`. */
export const DEFAULT_RESOURCE_APP = "jeb.pubky.app";

/** Hard cap on PUTs in one publish run: hard record cap × labels per resource. */
export const RESOURCE_WRITE_MAX = RESOURCE_RECORD_MAX * RESOURCE_LABELS_PER_RESOURCE_MAX;
/** Hard cap on deletes in one reconcile run: hard record cap × labels per resource. */
export const RESOURCE_DELETE_MAX = RESOURCE_RECORD_MAX * RESOURCE_LABELS_PER_RESOURCE_MAX;

const PUBKY_APP = "pubky.app";

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
  target: "staging";
  written: number;
  skipped_existing: number;
  failed: number;
  writes: ResourceTagWrite[];
  failures: Array<{ tagPath: string; label: string; normalizedUri: string; error: string }>;
}

function createdAtNumber(value: unknown): number {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value);
  throw new Error("tag created_at is missing");
}

function asTagBody(json: unknown): ResourceTagBody | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const rec = json as Record<string, unknown>;
  if (typeof rec.uri !== "string" || typeof rec.label !== "string") return null;
  try {
    return { uri: rec.uri, label: rec.label, created_at: createdAtNumber(rec.created_at) };
  } catch {
    return null;
  }
}

function canonicalTagJson(body: ResourceTagBody): string {
  return JSON.stringify({ uri: body.uri, label: body.label, created_at: body.created_at });
}

function isMissingOnHomeserver(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /404/.test(msg) || /not found/i.test(msg) || /directory not found/i.test(msg);
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
  target: "staging" | "production";
  expectedPilotPk: string;
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
  if (
    ctx.mode !== "reconcile" ||
    ctx.target !== "staging" ||
    ctx.expectedPilotPk !== ctx.botPk ||
    ctx.resolvedHomeserverPk !== STAGING_HOMESERVER_PK ||
    (ctx.resolvedHomeserverHost !== undefined && ctx.resolvedHomeserverHost !== STAGING_HOMESERVER_HOST)
  ) return { ok: false, reason: "mode" };
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
  app?: string;
  expectedPilotPk?: string;
  listedPaths?: ReadonlySet<string>;
  approvedDeletes?: ReadonlyMap<string, ResourceTagBody>;
  acceptedUris?: ReadonlyMap<string, string>;
  desiredByResource?: ReadonlyMap<string, ReadonlySet<string>>;
  retiredLabels?: ReadonlySet<string>;
  policy?: ReconcilePolicy;
};

export function gatedResourceTransport(inner: Transport, options?: GatedReconcileOptions): Transport {
  let executedPuts = 0;
  const gate = (): void => {
    const pk = inner.resolvedHomeserverPk;
    if (!pk) throw new Error("resource egress refused: session homeserver public key is missing");
    assertStagingHomeserverPk(pk);
    if (inner.resolvedHomeserverHost) {
      assertStagingResourceHomeserverHost(inner.resolvedHomeserverHost);
    }
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
      const uriReason = httpUrlRejectReason(body.uri);
      if (uriReason) throw new Error(uriReason);
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
      if (!options || options.mode !== "reconcile") throw new Error("gated resource transport does not allow deleteJson");
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
        target: "staging",
        expectedPilotPk: options.expectedPilotPk ?? "",
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
  const pk = inner.resolvedHomeserverPk;
  if (!pk) throw new Error("resource egress refused: session homeserver public key is missing");
  assertStagingHomeserverPk(pk);
  if (inner.resolvedHomeserverHost) assertStagingResourceHomeserverHost(inner.resolvedHomeserverHost);
  if (inner.botPk !== options.expectedPilotPk) throw new Error("reconcile pilot public key mismatch");
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

export function reconcilePlanSha256(
  plan: ResourceReconcilePlan,
  cfg: Pick<ReconcileConfig, "policy" | "retired" | "resourceConfigVersion" | "resourceApp"> & { botPk: string; resolvedHomeserverPk?: string; resolvedHomeserverHost?: string },
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
  };
  return createHash("sha256").update(JSON.stringify(preimage)).digest("hex");
}

function bodyForPath(client: Transport, path: string): Promise<unknown> {
  return client.getJson(path);
}

async function makeReconcilePlan(
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

export type ReconcileConfig = Pick<Config, "resourceTarget" | "resourceApp" | "resourceConfigVersion"> & {
  expectedPilotPk: string;
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
  if (cfg.resourceTarget !== "staging") throw new Error("external-resource seeding is staging-only");
  if (cfg.expectedPilotPk !== RESOURCE_PILOT_BOT_PK) throw new Error("reconcile pilot pin constant/flag mismatch");
  if (homeserverClient.botPk !== cfg.expectedPilotPk) throw new Error("reconcile pilot pin flag/session mismatch");
  assertStagingHomeserverPk(homeserverClient.resolvedHomeserverPk ?? "");
  const first = await makeReconcilePlan(accepted, cfg, homeserverClient);
  const hashContext = {
    policy: cfg.policy,
    retired: cfg.retired,
    resourceConfigVersion: cfg.resourceConfigVersion,
    resourceApp: cfg.resourceApp,
    botPk: homeserverClient.botPk,
    resolvedHomeserverPk: homeserverClient.resolvedHomeserverPk,
    resolvedHomeserverHost: homeserverClient.resolvedHomeserverHost,
  };
  const firstHash = reconcilePlanSha256(first.plan, hashContext);
  if (!cfg.execute) return { plan: first.plan, planSha256: firstHash };
  const second = await makeReconcilePlan(accepted, cfg, homeserverClient);
  if (semanticPlan(first.plan) !== semanticPlan(second.plan)) throw new Error("reconcile plan drift");
  const secondHash = reconcilePlanSha256(second.plan, hashContext);
  if (cfg.policy === "full" && cfg.confirmPlan !== secondHash) throw new Error("full reconcile requires matching --confirm-plan");
  const acceptedUris = new Map(accepted.map((r) => [resourceIdentity(normalizeUri(r.canonicalValue)), normalizeUri(r.canonicalValue)]));
  const putClient = gatedResourceTransport(homeserverClient);
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
    mode: "reconcile", app: cfg.resourceApp, expectedPilotPk: cfg.expectedPilotPk,
    listedPaths: second.listedPaths, approvedDeletes: second.approved,
    acceptedUris, desiredByResource: second.desiredByResource, retiredLabels: cfg.retired, policy: cfg.policy,
  });
  for (const action of [...second.plan.delete].sort(actionSort)) await gated.deleteJson(action.path);
  const verify = await makeReconcilePlan(accepted, cfg, homeserverClient);
  if (verify.plan.put.length || verify.plan.delete.length) throw new Error(`final desired-set mismatch: ${JSON.stringify(verify.plan)}`);
  return { plan: second.plan, planSha256: secondHash };
}

async function readExisting(client: Transport, path: string): Promise<ResourceTagBody | null> {
  try {
    const json = await client.getJson(path);
    if (json == null) return null;
    return asTagBody(json);
  } catch (err) {
    if (isMissingOnHomeserver(err)) return null;
    throw err;
  }
}

export async function publishResourceTags(
  accepted: readonly ExternalResource[],
  cfg: Pick<Config, "resourceTarget" | "resourceMode" | "resourceApp" | "resourceConfigVersion">,
  homeserverClient: Transport,
): Promise<ResourcePublishManifest> {
  if (cfg.resourceTarget !== "staging") {
    throw new Error("external-resource seeding is staging-only");
  }
  if (cfg.resourceMode !== "publish") {
    throw new Error("publishResourceTags requires resourceMode=publish");
  }
  const app = assertResourceAppName(cfg.resourceApp);
  const plannedWrites = accepted.reduce((n, resource) => n + resource.labels.length, 0);
  if (plannedWrites > RESOURCE_WRITE_MAX) {
    throw new Error(`resource publish run would issue ${plannedWrites} writes; max is ${RESOURCE_WRITE_MAX}`);
  }
  const client = gatedResourceTransport(homeserverClient);

  const manifest: ResourcePublishManifest = {
    configVersion: cfg.resourceConfigVersion,
    app,
    target: "staging",
    written: 0,
    skipped_existing: 0,
    failed: 0,
    writes: [],
    failures: [],
  };

  for (const resource of accepted) {
    const normalized = normalizeUri(resource.canonicalValue);
    const identity = resourceIdentity(normalized);
    for (const label of resource.labels) {
      let built: { path: string; tagId: string; body: ResourceTagBody };
      try {
        built = buildUniversalResourceTag(client.botPk, app, normalized, label);
        const uriReason = httpUrlRejectReason(normalized);
        if (uriReason) throw new Error(uriReason);
      } catch (err) {
        manifest.failed += 1;
        manifest.failures.push({
          tagPath: "",
          label,
          normalizedUri: normalized,
          error: err instanceof Error ? err.message : String(err),
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
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return manifest;
}
