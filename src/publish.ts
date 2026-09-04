import { createHash } from "node:crypto";
import { parsePostUri } from "./types.js";
import { Store } from "./db.js";
import type { Config } from "./config.js";
import {
  existingReply,
  openTransport,
  publicBotPk,
  publishCollection,
  publishReply,
  publishStandalone,
  type Transport,
} from "./homeserver.js";
import { closeServer, listenAdmin, listenHealth } from "./health.js";
import { log, withMention } from "./log.js";
import { metrics } from "./metrics.js";
import { envSwitchOn } from "./switches.js";
import { classifyAuthFailure, isAuthError, PublisherAuthError } from "./auth-error.js";
import {
  deleteArtifactTag,
  isArtifactTagLabel,
  putArtifactTag,
  putReplyTags,
  TAG_MAX_ATTEMPTS,
} from "./reply-tags.js";
import { scanOutboundText } from "./outbound-gate.js";
import { scanForSecrets, SECRET_DECLINE_REPLY } from "./secret-scrub.js";
import { awaitWithGrace, StoppingError } from "./shutdown.js";
import {
  assertAttachmentCount,
  buildCollectionPost,
  collectionMentionKey,
  collectionPostId,
  type CollectionLayout,
  type StandalonePostKind,
} from "./post.js";

export function validatePublishShape(row: {
  mention_key: string;
  parent_uri: string;
  content: string;
  standalone?: boolean;
}): void {
  if (row.content.length > 50_000) throw new Error("content exceeds 50000");
  if (row.standalone) return;
  parsePostUri(row.parent_uri);
  if (row.mention_key !== row.parent_uri) {
    parsePostUri(row.mention_key);
  }
}

async function repliesBlocked(store: Store, cfg: Config): Promise<boolean> {
  return cfg.disabledEnv || envSwitchOn("replies") || envSwitchOn("global") || (await store.switchOn("replies"));
}

async function proactiveBlocked(store: Store, cfg: Config): Promise<boolean> {
  return cfg.disabledEnv || envSwitchOn("proactive") || envSwitchOn("global") || (await store.switchOn("proactive"));
}

function standaloneSeed(opts: {
  content: string;
  kind: StandalonePostKind;
  attachments?: string[];
  collectionId?: string | null;
}): string {
  return JSON.stringify({
    content: opts.content,
    kind: opts.kind,
    attachments: opts.attachments ?? [],
    collectionId: opts.collectionId ?? null,
  });
}

export function standalonePostId(seed: string): string {
  return createHash("sha256").update(seed).digest("hex").slice(0, 13).toUpperCase();
}

/**
 * Queue an operator-approved standalone post for the publisher. The drafts
 * module calls this after a human approval; there is no autonomous path.
 * Duplicate payload hashes are a no-op (same mention_key / post id).
 */
export async function enqueueStandalonePost(
  store: Store,
  opts: {
    content: string;
    kind: StandalonePostKind;
    attachments?: string[];
    collectionId?: string | null;
    approvedBy: string;
    client?: { query: import("pg").Pool["query"] };
  },
): Promise<{ mentionKey: string; postId: string; inserted: boolean }> {
  const approvedBy = opts.approvedBy.trim();
  if (!approvedBy) throw new Error("approvedBy is required");
  if (opts.kind !== "short" && opts.kind !== "long") throw new Error("kind must be short or long");
  if (opts.attachments) assertAttachmentCount(opts.attachments.length);
  const seed = standaloneSeed(opts);
  const postId = standalonePostId(seed);
  const mentionKey = `standalone:${createHash("sha256").update(seed).digest("hex")}`;
  const inserted = await store.insertPublishRequest({
    mentionKey,
    parentUri: mentionKey,
    content: opts.content,
    evidenceId: null,
    standalone: true,
    postKind: opts.kind,
    attachments: opts.attachments ?? null,
    collectionId: opts.collectionId ?? null,
    approvedBy,
    replacePostId: postId,
    client: opts.client,
  });
  return { mentionKey, postId, inserted };
}

/**
 * Queue an operator-approved Jeb-authored collection. The homeserver path is
 * deterministic from the title, so a later upsert supersedes the prior row
 * and the publisher overwrites the same post id.
 */
export async function enqueueCollectionUpsert(
  store: Store,
  opts: {
    title: string;
    description: string;
    itemUris: string[];
    layout?: CollectionLayout;
    approvedBy: string;
  },
): Promise<{ mentionKey: string; postId: string; inserted: boolean; content: string }> {
  const approvedBy = opts.approvedBy.trim();
  if (!approvedBy) throw new Error("approvedBy is required");
  const built = buildCollectionPost("a".repeat(52), opts);
  const title = opts.title.trim();
  const postId = collectionPostId(title);
  const mentionKey = collectionMentionKey(title);
  await store.supersedePublishForReplace(mentionKey);
  const inserted = await store.insertPublishRequest({
    mentionKey,
    parentUri: mentionKey,
    content: built.content,
    evidenceId: null,
    standalone: true,
    postKind: "collection",
    collectionId: postId,
    approvedBy,
    replacePostId: postId,
  });
  return { mentionKey, postId, inserted, content: built.content };
}

/**
 * Queue an operator-approved artifact tag on any public post. Labels outside
 * ARTIFACT_TAG_VOCAB are rejected. One active approval row per (uri, label).
 */
export async function enqueuePostTag(
  store: Store,
  opts: { postUri: string; label: string; approvedBy: string },
): Promise<{ inserted: boolean }> {
  parsePostUri(opts.postUri);
  const approvedBy = opts.approvedBy.trim();
  if (!approvedBy) throw new Error("approvedBy is required");
  if (!isArtifactTagLabel(opts.label)) {
    throw new Error(`tag label not in artifact vocabulary: ${opts.label}`);
  }
  const inserted = await store.insertArtifactTag({
    postUri: opts.postUri,
    label: opts.label,
    approvedBy,
  });
  return { inserted };
}

export async function revokePostTag(
  store: Store,
  transport: Transport,
  opts: { postUri: string; label: string; approvedBy: string },
): Promise<void> {
  parsePostUri(opts.postUri);
  const approvedBy = opts.approvedBy.trim();
  if (!approvedBy) throw new Error("approvedBy is required");
  if (!isArtifactTagLabel(opts.label)) {
    throw new Error(`tag label not in artifact vocabulary: ${opts.label}`);
  }
  const path = await deleteArtifactTag(transport, opts.postUri, opts.label);
  const row = await store.getArtifactTag(opts.postUri, opts.label);
  if (row) await store.markArtifactTagRevoked(row.id);
  log.info({ uri: opts.postUri, label: opts.label, path, by: approvedBy }, "artifact tag revoked");
}

/** Thrown when the replies/global kill switch blocks a tag pass; never counted as a tag attempt. */
export class TagsBlockedError extends Error {}

/**
 * Ticket 12c (§4.4b): writes the category self-tags for one published reply.
 * Best-effort by design — the reply already exists, so a tag failure never
 * fails the publish: it is logged at warn and retried on a later tick (up to
 * TAG_MAX_ATTEMPTS attempts, tracked on the row), then given up. Idempotent:
 * skipped when `tag_uris` is already recorded, and a tag re-PUT overwrites
 * the same object (tag id = hash of uri+label).
 */
export async function tagOne(
  store: Store,
  transport: Transport,
  cfg: Config,
  row: { id: number; mention_key: string; reply_uri: string; categories: string[] },
  opts?: { stopping?: () => boolean },
): Promise<void> {
  const stopping = opts?.stopping ?? (() => false);
  if (stopping()) return;
  if (cfg.selfTags === false) return;
  const lg = withMention(row.mention_key);
  if (row.categories.length === 0) {
    if (stopping()) return;
    await store.markTagsDone(row.id, []);
    return;
  }
  // Same gate as the reply itself, re-checked immediately before the tag PUTs.
  if (await repliesBlocked(store, cfg)) throw new TagsBlockedError("replies switch on");
  if (stopping()) return;
  // Secret scrubber before the tag PUTs. Labels come from a fixed vocabulary,
  // so this should never fire; if it does, the label is dropped, not published.
  const cleanLabels: string[] = [];
  for (const label of row.categories) {
    const scan = scanForSecrets(label);
    if (scan.clean) {
      cleanLabels.push(label);
      continue;
    }
    const rules = scan.hits.map((h) => h.rule);
    for (const rule of rules) metrics.incrementSecurityEvent(rule);
    lg.warn({ event: "security_event", rules }, "secret-scrubber dropped outbound tag label");
  }
  if (cleanLabels.length === 0) {
    if (stopping()) return;
    await store.markTagsDone(row.id, []);
    return;
  }
  try {
    const uris = await putReplyTags(transport, row.reply_uri, cleanLabels, { stopping });
    if (stopping()) return;
    await store.markTagsDone(row.id, uris);
    lg.info({ tag_uris: uris }, "reply tags published");
  } catch (e) {
    if (e instanceof StoppingError || stopping()) return;
    await store.markTagRetry(row.id, String(e));
    lg.warn({ err: String(e) }, "reply tag PUT failed; retrying on a later tick");
  }
}

export async function applyArtifactTagOne(
  store: Store,
  transport: Transport,
  cfg: Config,
  row: { id: number; post_uri: string; label: string },
): Promise<void> {
  if (await repliesBlocked(store, cfg)) throw new TagsBlockedError("replies switch on");
  if (await proactiveBlocked(store, cfg)) throw new TagsBlockedError("proactive switch on");
  const scan = scanForSecrets(row.label);
  if (!scan.clean) {
    const rules = scan.hits.map((h) => h.rule);
    for (const rule of rules) metrics.incrementSecurityEvent(rule);
    await store.markArtifactTagFailed(row.id, "secret-scrubber dropped outbound tag label");
    log.warn({ event: "security_event", rules, uri: row.post_uri, label: row.label }, "secret-scrubber dropped outbound artifact tag");
    return;
  }
  const uri = await putArtifactTag(transport, row.post_uri, row.label);
  await store.markArtifactTagDone(row.id, uri);
  log.info({ uri: row.post_uri, label: row.label }, "artifact tag published");
}

export async function publishOne(
  store: Store,
  transport: Transport,
  cfg: Config,
  row: {
    id: number;
    mention_key: string;
    parent_uri: string;
    content: string;
    attempts: number;
    fail_first_attempt: boolean;
    evidence_id?: number | null;
    scrubbed?: boolean;
    replace_post_id?: string | null;
    standalone?: boolean;
    post_kind?: string | null;
    attachments?: string[] | null;
    collection_id?: string | null;
  },
): Promise<void> {
  const standalone = row.standalone === true;
  const lg = withMention(row.mention_key);
  validatePublishShape(row);
  if (!standalone) {
    const claimed = await store.get(row.mention_key);
    if (!claimed) throw new Error("mention_key not claimed");
    if (claimed.status === "published") {
      await store.markPublishDone(row.id);
      return;
    }
    // F-12: skip only when the mention was explicitly skipped/failed after this
    // request was queued. Any other status (processing, or a crash leaving the
    // claim row as-is) must still PUT / reconcile.
    if (claimed.status === "skipped" || claimed.status === "failed") {
      await store.markPublishDone(row.id);
      lg.info({ status: claimed.status }, "publish skipped: mention skipped or failed");
      return;
    }
  }

  const replaceId = row.replace_post_id?.trim().toUpperCase() || null;
  // The publisher is the trust boundary for the signing key: re-validate the
  // replace id before it is interpolated into a homeserver storage path. A
  // malformed id fails the row loudly and is never PUT.
  if (replaceId && !/^[A-Z0-9]{13}$/.test(replaceId)) {
    await store.markPublishFailed(row.id, "invalid replace_post_id shape");
    lg.error(
      { event: "security_event", reason: "invalid_replace_post_id" },
      "publish refused: replace_post_id failed /^[A-Z0-9]{13}$/ shape check",
    );
    return;
  }
  // A replace must PUT even though the old reply is still listed under this parent.
  // After a successful overwrite, retry still PUTs the same path (no new post id).
  if (!standalone && !replaceId) {
    const found = await existingReply(transport, row.parent_uri);
    if (found) {
      const claimed = await store.get(row.mention_key);
      await store.mark(row.mention_key, "published", { replyUri: found, rootUri: claimed?.root_uri ?? undefined });
      await store.markPublishDone(row.id);
      return;
    }
  }

  if (await repliesBlocked(store, cfg)) {
    throw new Error("replies switch on");
  }
  if (standalone && (await proactiveBlocked(store, cfg))) {
    throw new Error("proactive switch on");
  }

  if (row.fail_first_attempt && row.attempts <= 1) {
    await store.clearFailFirst(row.id);
    throw new Error("fail_first_attempt");
  }

  if (await repliesBlocked(store, cfg)) {
    throw new Error("replies switch on");
  }
  if (standalone && (await proactiveBlocked(store, cfg))) {
    throw new Error("proactive switch on");
  }

  // Outbound gate: the LAST check before the PUT (value-matched secret
  // scrubber + prompt-echo shingles). Flagged content is never published
  // under the bot key; the deterministic decline goes out instead, tagged
  // `declined`, with rule ids (never matched text) recorded. A row already
  // marked `scrubbed` fired the gate on an earlier attempt: publish the
  // decline without re-scanning or re-appending security_event evidence.
  const collection = standalone && row.post_kind === "collection";
  let content = row.content;
  if (row.scrubbed) {
    if (collection) {
      await store.markPublishFailed(row.id, "secret-scrubber blocked collection upsert");
      lg.warn({ event: "security_event" }, "secret-scrubber blocked collection; decline is not a valid collection envelope");
      return;
    }
    content = SECRET_DECLINE_REPLY;
  } else {
    const scan = scanOutboundText(row.content);
    if (!scan.clean) {
      const rules = scan.hits.map((h) => h.rule);
      for (const rule of rules) metrics.incrementSecurityEvent(rule);
      lg.warn({ event: "security_event", rules }, "secret-scrubber blocked outbound reply");
      await store.markPublishScrubbed(row.id);
      await store.appendEvidenceSecurityEvents(row.evidence_id ?? null, rules);
      await store.setPublishCategories(row.id, ["declined"]);
      if (collection) {
        await store.markPublishFailed(row.id, "secret-scrubber blocked collection upsert");
        return;
      }
      content = SECRET_DECLINE_REPLY;
    }
  }

  const putStarted = Date.now();
  const put = async () => {
    if (standalone) {
      if (!replaceId) throw new Error("standalone publish requires replace_post_id");
      if (collection) {
        const envelope = JSON.parse(content) as {
          name?: string;
          description?: string;
          items?: string[];
          layout?: CollectionLayout;
        };
        if (typeof envelope.name !== "string" || !Array.isArray(envelope.items)) {
          throw new Error("collection content is not a valid envelope");
        }
        return publishCollection(
          transport,
          {
            title: envelope.name,
            description: typeof envelope.description === "string" ? envelope.description : "",
            itemUris: envelope.items,
            layout: envelope.layout,
          },
          replaceId,
        );
      }
      const kind: StandalonePostKind = row.post_kind === "long" ? "long" : "short";
      return publishStandalone(transport, content, kind, replaceId, row.attachments ?? null);
    }
    return publishReply(transport, row.parent_uri, content, replaceId);
  };
  let published;
  try {
    published = await put();
  } catch (e) {
    if (!isAuthError(e)) throw e;
    try {
      await transport.reauth();
      published = await put();
    } catch (e2) {
      if (isAuthError(e2)) throw new PublisherAuthError(String(e2));
      throw e2;
    }
  }
  const publishMs = Date.now() - putStarted;
  if (!standalone) {
    const claimed = await store.get(row.mention_key);
    await store.mark(row.mention_key, "published", { replyUri: published.uri, rootUri: claimed?.root_uri ?? undefined });
  }
  await store.markPublishDone(row.id);
  if (standalone) await store.markLinkedDraftPublished(row.id);
  await store.mergeEvidencePhaseMs(row.evidence_id ?? null, { publish: publishMs });
  metrics.incrementReplies(standalone ? "standalone" : "answer");
  metrics.incrementMentions("processed");
  lg.info({ reply_uri: published.uri, publish_ms: publishMs, standalone }, "published");
}

export async function runPublish(
  cfg: Config,
  opts?: { transport?: Transport },
): Promise<() => Promise<void>> {
  if (!opts?.transport && !process.env.PUBKY_BOT_SECRET_KEY_HEX && !process.env.PUBKY_BOT_MNEMONIC && !cfg.secretKeyHex) {
    throw new Error("publish requires key material");
  }
  const store = new Store(cfg.databaseUrl);
  await store.migrate();
  let transport: Transport;
  if (opts?.transport) {
    transport = opts.transport;
  } else {
    try {
      transport = await openTransport({
        secretKeyHex: cfg.secretKeyHex,
        homeserverPk: cfg.homeserverPk,
        signupToken: cfg.signupToken,
        testnet: cfg.testnet,
      });
    } catch (e) {
      const botPk = cfg.botPk || publicBotPk(cfg.secretKeyHex);
      log.error({ reason: classifyAuthFailure(e, botPk) }, "publisher auth failed");
      process.exit(1);
    }
  }
  let stopped = false;
  let authFailed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let tickInFlight: Promise<void> | null = null;
  const health =
    cfg.port && Number.isFinite(cfg.port)
      ? listenHealth(cfg.port + 2, () => Date.now(), cfg.bind, () => ({
          publisher_auth: authFailed ? "failed" : "ok",
        }))
      : null;
  // The publish process is the only one that holds secret env, so it alone
  // serves the admin listener (reason/ingest children never see ADMIN_TOKEN
  // or JEB_ADMIN_PORT under `--role all`).
  const admin =
    cfg.adminPort && Number.isFinite(cfg.adminPort)
      ? listenAdmin(cfg.adminPort, cfg.adminToken, store, cfg.bind)
      : null;

  const stopping = () => stopped;

  const tick = (): void => {
    if (stopped) return;
    tickInFlight = (async () => {
      try {
        if (authFailed) {
          try {
            await transport.reauth();
            authFailed = false;
          } catch {
            /* stay paused */
          }
        } else {
          await store.failExhaustedPublishes(cfg.maxPublishAttempts, cfg.publishStaleMs);
          const row = await store.claimPublish(cfg.maxPublishAttempts, cfg.publishStaleMs);
          if (row) {
            try {
              await publishOne(store, transport, cfg, row);
            } catch (e) {
              if (e instanceof PublisherAuthError) {
                authFailed = true;
                metrics.incrementAuthFailed();
                log.error({ reason: classifyAuthFailure(e, transport.botPk), mention_key: row.mention_key }, "publisher auth failed");
                await store.markPublishFailedAuth(row.id, e.message);
              } else {
                await store.markPublishRetry(row.id, String(e), row.attempts);
              }
            }
          }
          // Ticket 12c: category self-tags on published replies. Independent of
          // the publish path above and never allowed to affect it; skipped
          // entirely while the replies/global switch is on or JEB_SELF_TAGS=0.
          // A tick already in flight still finishes its reply; a tag pass does
          // not start after stop() has been requested.
          if (stopped) return;
          if (cfg.selfTags !== false && !(await repliesBlocked(store, cfg))) {
            try {
              if (stopped) return;
              const tagRow = await store.claimPendingTags(TAG_MAX_ATTEMPTS);
              if (tagRow && !stopped) await tagOne(store, transport, cfg, tagRow, { stopping });
            } catch (e) {
              if (!(e instanceof TagsBlockedError) && !(e instanceof StoppingError)) {
                log.warn({ err: String(e) }, "reply tag pass failed");
              }
            }
          }
          if (stopped) return;
          if (!(await repliesBlocked(store, cfg)) && !(await proactiveBlocked(store, cfg))) {
            try {
              const artifactRow = await store.claimPendingArtifactTag(TAG_MAX_ATTEMPTS, cfg.publishStaleMs);
              if (artifactRow && !stopped) {
                try {
                  await applyArtifactTagOne(store, transport, cfg, artifactRow);
                } catch (e) {
                  if (e instanceof TagsBlockedError) return;
                  await store.markArtifactTagRetry(artifactRow.id, String(e), artifactRow.attempts);
                }
              }
            } catch (e) {
              if (!(e instanceof TagsBlockedError)) {
                log.warn({ err: String(e) }, "artifact tag pass failed");
              }
            }
          }
        }
      } catch {
        /* keep */
      }
    })();
    void tickInFlight.then(() => {
      if (!stopped) timer = setTimeout(tick, 40);
    });
  };
  tick();
  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await awaitWithGrace(tickInFlight);
    await closeServer(health);
    await closeServer(admin);
    await store.close();
  };
}
