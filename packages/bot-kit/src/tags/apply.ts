import { PubkySpecsBuilder } from "pubky-app-specs";
import { log } from "../log.js";
import type { Transport } from "../publish/homeserver.js";
import { enqueuePostTag, proactiveBlocked, repliesBlocked, type PublishGateConfig } from "../publish/publisher.js";
import { StoppingError } from "../shutdown.js";
import { parsePostUri } from "../types.js";
import { AUTO_ARTIFACT_APPROVER, filterOpenTags, isValidOpenTagLabel, rejectOpenTagReason } from "./policy.js";
import type { TagStore } from "./tag-store.js";

export type ApplyTagsMode = "self" | "artifact";

export type ApplyTagsInput = {
  targetUri: string;
  labels: string[];
  mode: ApplyTagsMode;
  approvedBy?: string;
  personTokens?: string[];
};

export type ApplyTagsResult = { uris: string[]; inserted: boolean };

export type ApplyTagsDeps = {
  store: TagStore;
  /** Required for a PUT. Artifact enqueue-only (CLI apply) omits this. */
  transport?: Transport;
  cfg?: PublishGateConfig;
  envSwitchOn?: (name: "replies" | "global" | "proactive" | "collections") => boolean;
  incrementSecurityEvent?: (rule: string) => void;
  /** Unused for validity; kept so older callers still type-check. */
  selfVocab?: readonly string[];
  artifactVocab?: readonly string[];
  selfTags?: boolean;
  stopping?: () => boolean;
  mentionKey?: string;
};

function assertOpenLabels(labels: string[], personTokens?: readonly string[]): void {
  const seen = new Set<string>();
  for (const label of labels) {
    if (seen.has(label)) continue;
    seen.add(label);
    const reason = rejectOpenTagReason(label, { personTokens });
    if (reason) throw new Error(`invalid tag label: ${JSON.stringify(label)} (${reason})`);
  }
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
  opts?: { stopping?: () => boolean; vocab?: readonly string[] },
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
    if (opts?.stopping?.()) throw new StoppingError();
    if (!isValidOpenTagLabel(label)) throw new Error(`invalid tag label: ${JSON.stringify(label)}`);
    if (opts?.vocab && opts.vocab.length > 0 && !(opts.vocab as readonly string[]).includes(label)) {
      throw new Error(`tag label not in vocabulary: ${JSON.stringify(label)}`);
    }
    const { tag, meta } = specs.createTag(replyUri, label);
    if (opts?.stopping?.()) throw new StoppingError();
    await transport.putJson(meta.path, tag.toJson());
    uris.push(meta.url);
  }
  return uris;
}

export function artifactTagObject(
  botPk: string,
  postUri: string,
  label: string,
  _vocab?: readonly string[],
): { path: string; url: string; json: unknown } {
  parsePostUri(postUri);
  if (!isValidOpenTagLabel(label)) throw new Error(`invalid tag label: ${JSON.stringify(label)}`);
  const specs = new PubkySpecsBuilder(botPk);
  const { tag, meta } = specs.createTag(postUri, label);
  return { path: meta.path, url: meta.url, json: tag.toJson() };
}

export async function putArtifactTag(
  transport: Transport,
  postUri: string,
  label: string,
  vocab?: readonly string[],
): Promise<string> {
  const built = artifactTagObject(transport.botPk, postUri, label, vocab);
  await transport.putJson(built.path, built.json);
  return built.url;
}

export async function deleteArtifactTag(
  transport: Transport,
  postUri: string,
  label: string,
  vocab?: readonly string[],
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

 *   transport is present and the replies switch is off. No operator approval.
 * - `artifact`: operator `approvedBy` required unless Jeb already replied to
 *   the target (`botRepliedTo`); then `approved_by` is the auto sentinel.
 *   Enqueue via `enqueuePostTag`; PUT via `putArtifactTag` when a transport is
 *   present and replies+proactive are off. A successful artifact PUT does
 *   **not** finalize the row: the kit path never claims, so
 *   `markArtifactTagDone` is a no-op while status is `queued`. Finalization is
 *   left to the claiming publisher tick (Jeb converges via the next
 *   `applyArtifactTagOne`). Non-Jeb consumers that drive `applyTags` with a
 *   transport and no publisher loop will see the tag live and the row still
 *   `queued`.
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
    assertOpenLabels(input.labels, input.personTokens);
    if (await repliesBlocked(deps.store, cfg, envSwitchOn)) {
      return { uris: [], inserted: false };
    }
    const clean = filterOpenTags(input.labels, {
      personTokens: input.personTokens,
      incrementSecurityEvent: deps.incrementSecurityEvent,
    });
    if (clean.length === 0) return { uris: [], inserted: false };
    const uris = await putReplyTags(transport, input.targetUri, clean, {
      stopping: deps.stopping,
    });
    await deps.store.markSelfTagsDone(input.targetUri, uris);
    return { uris, inserted: uris.length > 0 };
  }

  assertOpenLabels(input.labels, input.personTokens);
  const answered = deps.store.botRepliedTo ? await deps.store.botRepliedTo(input.targetUri) : false;
  let approvedBy = (input.approvedBy ?? "").trim();
  if (!approvedBy) {
    if (answered) approvedBy = AUTO_ARTIFACT_APPROVER;
    else throw new Error("approvedBy is required");
  }

  let inserted = false;
  const seen = new Set<string>();
  for (const label of input.labels) {
    if (seen.has(label)) continue;
    seen.add(label);
    const queued = await enqueuePostTag(deps.store, { postUri: input.targetUri, label, approvedBy }, isValidOpenTagLabel);
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
    if (rejectOpenTagReason(label, { personTokens: input.personTokens, incrementSecurityEvent: deps.incrementSecurityEvent })) {
      const row = await deps.store.getArtifactTag(input.targetUri, label);
      if (row) await deps.store.markArtifactTagFailed(row.id, "tag policy dropped outbound tag label");
      continue;
    }
    const uri = await putArtifactTag(transport, input.targetUri, label);
    const row = await deps.store.getArtifactTag(input.targetUri, label);
    if (row?.status === "revoked") {
      try {
        await deleteArtifactTag(transport, input.targetUri, label);
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
            await deleteArtifactTag(transport, input.targetUri, label);
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
