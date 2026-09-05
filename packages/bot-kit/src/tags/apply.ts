import { PubkySpecsBuilder } from "pubky-app-specs";
import { log } from "../log.js";
import type { Transport } from "../publish/homeserver.js";
import { enqueuePostTag, proactiveBlocked, repliesBlocked, type PublishGateConfig } from "../publish/publisher.js";
import { scanForSecrets } from "../security/secret-scrub.js";
import { StoppingError } from "../shutdown.js";
import { parsePostUri } from "../types.js";
import { isValidTagLabel } from "./suggest.js";
import type { TagStore } from "./tag-store.js";

export type ApplyTagsMode = "self" | "artifact";

export type ApplyTagsInput = {
  targetUri: string;
  labels: string[];
  mode: ApplyTagsMode;
  approvedBy?: string;
};

export type ApplyTagsResult = { uris: string[]; inserted: boolean };

export type ApplyTagsDeps = {
  store: TagStore;
  /** Required for a PUT. Artifact enqueue-only (CLI apply) omits this. */
  transport?: Transport;
  cfg?: PublishGateConfig;
  envSwitchOn?: (name: "replies" | "global" | "proactive") => boolean;
  incrementSecurityEvent?: (rule: string) => void;
  selfVocab: readonly string[];
  artifactVocab: readonly string[];
  selfTags?: boolean;
  stopping?: () => boolean;
  mentionKey?: string;
};

function assertLabels(labels: string[], vocab: readonly string[], vocabName: string): void {
  const seen = new Set<string>();
  for (const label of labels) {
    if (seen.has(label)) continue;
    seen.add(label);
    if (!isValidTagLabel(label)) throw new Error(`invalid tag label: ${JSON.stringify(label)}`);
    if (!(vocab as readonly string[]).includes(label)) {
      throw new Error(`tag label not in ${vocabName}: ${JSON.stringify(label)}`);
    }
  }
}

function scrubLabels(
  labels: string[],
  incrementSecurityEvent?: (rule: string) => void,
): string[] {
  const clean: string[] = [];
  const seen = new Set<string>();
  for (const label of labels) {
    if (seen.has(label)) continue;
    seen.add(label);
    const scan = scanForSecrets(label);
    if (scan.clean) {
      clean.push(label);
      continue;
    }
    for (const hit of scan.hits) incrementSecurityEvent?.(hit.rule);
  }
  return clean;
}

/**
 * Builds and PUTs one tag per label on `replyUri`, returning the tag URIs.
 *
 * Hard rule: only ever the bot's own reply — the URI author must equal the
 * transport's bot key, checked before any PUT. Re-PUT is idempotent: the tag
 * id is a hash of uri+label, so a retry overwrites the same object.
 */
export async function putReplyTags(
  transport: Transport,
  replyUri: string,
  labels: string[],
  opts: { stopping?: () => boolean; vocab: readonly string[] },
): Promise<string[]> {
  const { author } = parsePostUri(replyUri);
  if (author.toLowerCase() !== transport.botPk.toLowerCase()) {
    throw new Error("refusing to tag a post not authored by the bot key");
  }
  const specs = new PubkySpecsBuilder(transport.botPk);
  const uris: string[] = [];
  const seen = new Set<string>();
  for (const label of labels) {
    if (seen.has(label)) continue;
    seen.add(label);
    if (opts.stopping?.()) throw new StoppingError();
    if (!isValidTagLabel(label)) throw new Error(`invalid tag label: ${JSON.stringify(label)}`);
    if (!(opts.vocab as readonly string[]).includes(label)) {
      throw new Error(`tag label not in vocabulary: ${JSON.stringify(label)}`);
    }
    const { tag, meta } = specs.createTag(replyUri, label);
    if (opts.stopping?.()) throw new StoppingError();
    await transport.putJson(meta.path, tag.toJson());
    uris.push(meta.url);
  }
  return uris;
}

/**
 * Builds the tag object for `label` on any public post URI under the bot key.
 * Dedupes by spec: tag id is a hash of uri+label, so a re-PUT overwrites.
 */
export function artifactTagObject(
  botPk: string,
  postUri: string,
  label: string,
  vocab: readonly string[],
): { path: string; url: string; json: unknown } {
  parsePostUri(postUri);
  if (!isValidTagLabel(label)) throw new Error(`invalid tag label: ${JSON.stringify(label)}`);
  if (!(vocab as readonly string[]).includes(label)) {
    throw new Error(`tag label not in artifact vocabulary: ${JSON.stringify(label)}`);
  }
  const specs = new PubkySpecsBuilder(botPk);
  const { tag, meta } = specs.createTag(postUri, label);
  return { path: meta.path, url: meta.url, json: tag.toJson() };
}

export async function putArtifactTag(
  transport: Transport,
  postUri: string,
  label: string,
  vocab: readonly string[],
): Promise<string> {
  const built = artifactTagObject(transport.botPk, postUri, label, vocab);
  await transport.putJson(built.path, built.json);
  return built.url;
}

export async function deleteArtifactTag(
  transport: Transport,
  postUri: string,
  label: string,
  vocab: readonly string[],
): Promise<string> {
  const built = artifactTagObject(transport.botPk, postUri, label, vocab);
  await transport.deleteJson(built.path);
  return built.path;
}

/**
 * Capability gate for tags. Nothing PUTs a tag except through this path or
 * the publisher (`tagOne` / `applyArtifactTagOne`), which call the same PUT
 * helpers.
 *
 * - `self`: target must be bot-authored; PUT via `putReplyTags` when a
 *   transport is present and the replies switch is off.
 * - `artifact`: `approvedBy` required; enqueue via `enqueuePostTag`; PUT via
 *   `putArtifactTag` when a transport is present and replies+proactive are off.
 *   A successful artifact PUT does **not** finalize the row: the kit path
 *   never claims, so `markArtifactTagDone` is a no-op while status is
 *   `queued`. Finalization is left to the claiming publisher tick (Jeb
 *   converges via the next `applyArtifactTagOne`). Non-Jeb consumers that
 *   drive `applyTags` with a transport and no publisher loop will see the
 *   tag live and the row still `queued`.
 */
export async function applyTags(input: ApplyTagsInput, deps: ApplyTagsDeps): Promise<ApplyTagsResult> {
  parsePostUri(input.targetUri);
  const cfg: PublishGateConfig = deps.cfg ?? { disabledEnv: false };
  const envSwitchOn = deps.envSwitchOn ?? (() => false);

  if (input.mode === "self") {
    if (deps.selfTags === false) return { uris: [], inserted: false };
    const transport = deps.transport;
    if (!transport) throw new Error("self tags require the publish transport");
    const { author } = parsePostUri(input.targetUri);
    if (author.toLowerCase() !== transport.botPk.toLowerCase()) {
      throw new Error("refusing to tag a post not authored by the bot key");
    }
    assertLabels(input.labels, deps.selfVocab, "vocabulary");
    if (await repliesBlocked(deps.store, cfg, envSwitchOn)) {
      return { uris: [], inserted: false };
    }
    const clean = scrubLabels(input.labels, deps.incrementSecurityEvent);
    if (clean.length === 0) return { uris: [], inserted: false };
    const uris = await putReplyTags(transport, input.targetUri, clean, {
      stopping: deps.stopping,
      vocab: deps.selfVocab,
    });
    await deps.store.markSelfTagsDone(input.targetUri, uris);
    return { uris, inserted: uris.length > 0 };
  }

  const approvedBy = (input.approvedBy ?? "").trim();
  if (!approvedBy) throw new Error("approvedBy is required");
  assertLabels(input.labels, deps.artifactVocab, "artifact vocabulary");
  const isArtifact = (label: string) => (deps.artifactVocab as readonly string[]).includes(label);

  let inserted = false;
  const seen = new Set<string>();
  for (const label of input.labels) {
    if (seen.has(label)) continue;
    seen.add(label);
    const queued = await enqueuePostTag(deps.store, { postUri: input.targetUri, label, approvedBy }, isArtifact);
    if (queued.inserted) inserted = true;
  }

  const transport = deps.transport;
  if (!transport) {
    return { uris: [], inserted };
  }

  if ((await repliesBlocked(deps.store, cfg, envSwitchOn)) || (await proactiveBlocked(deps.store, cfg, envSwitchOn))) {
    return { uris: [], inserted };
  }

  const uris: string[] = [];
  for (const label of seen) {
    const scan = scanForSecrets(label);
    if (!scan.clean) {
      for (const hit of scan.hits) deps.incrementSecurityEvent?.(hit.rule);
      const row = await deps.store.getArtifactTag(input.targetUri, label);
      if (row) await deps.store.markArtifactTagFailed(row.id, "secret-scrubber dropped outbound tag label");
      continue;
    }
    const uri = await putArtifactTag(transport, input.targetUri, label, deps.artifactVocab);
    const row = await deps.store.getArtifactTag(input.targetUri, label);
    if (row?.status === "revoked") {
      try {
        await deleteArtifactTag(transport, input.targetUri, label, deps.artifactVocab);
      } catch (e) {
        log.warn(
          { uri: input.targetUri, label, err: String(e) },
          "artifact tag rollback DELETE failed; row stayed revoked",
        );
      }
      continue;
    }
    if (row) {
      const done = await deps.store.markArtifactTagDone(row.id, uri);
      if (done === 0) {
        const again = await deps.store.getArtifactTag(input.targetUri, label);
        if (again?.status === "revoked") {
          try {
            await deleteArtifactTag(transport, input.targetUri, label, deps.artifactVocab);
          } catch (e) {
            log.warn(
              { uri: input.targetUri, label, err: String(e) },
              "artifact tag rollback DELETE failed; row stayed revoked",
            );
          }
          continue;
        }
      }
    }
    uris.push(uri);
  }
  return { uris, inserted };
}
