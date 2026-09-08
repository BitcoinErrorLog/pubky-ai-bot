import { PubkyAppTag, PubkySpecsBuilder, getValidationLimits } from "pubky-app-specs";
import type { Config } from "./config.js";
import type { ExternalResource } from "./external-resources.js";
import { isValidOpenTagLabel } from "./bot-kit/tags/policy.js";
import type { Transport } from "./homeserver.js";
import {
  assertOutboundClean,
  assertStagingHomeserverPk,
  assertStagingResourceHomeserverHost,
} from "./outbound-gate.js";
import { normalizeUri, resourceIdentity } from "./resource-identity.js";
import { httpUrlRejectReason } from "./resource-url-safety.js";

/** Default app segment for universal tags. Must not be `pubky.app`. */
export const DEFAULT_RESOURCE_APP = "jeb.pubky.app";

/** Hard cap on PUTs in one publish run (accepted records × labels). */
export const RESOURCE_WRITE_MAX = 300;

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

export function gatedResourceTransport(inner: Transport): Transport {
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
      throw new Error("gated resource transport does not allow deleteJson");
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
