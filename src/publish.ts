import type { Config } from "./config.js";
import { Store } from "./db.js";
import { closeServer, listenAdmin, listenHealth } from "./health.js";
import { metrics } from "./metrics.js";
import { envSwitchOn } from "./switches.js";
import {
  deleteArtifactTag,
  isArtifactTagLabel,
  putArtifactTag,
  putReplyTags,
  REPLY_TAG_VOCABULARY,
  TAG_MAX_ATTEMPTS,
} from "./reply-tags.js";
import { scanOutboundText } from "./outbound-gate.js";
import { SECRET_DECLINE_REPLY } from "./secret-scrub.js";
import type { Transport } from "./homeserver.js";
import {
  applyArtifactTagOne as kitApplyArtifactTagOne,
  enqueueCollectionUpsert as kitEnqueueCollectionUpsert,
  enqueuePostTag as kitEnqueuePostTag,
  enqueueStandalonePost as kitEnqueueStandalonePost,
  publishOne as kitPublishOne,
  revokePostTag as kitRevokePostTag,
  runPublish as kitRunPublish,
  tagOne as kitTagOne,
  type PublishHooks,
  type PublishStore,
} from "./bot-kit/publish/publisher.js";

export {
  validatePublishShape,
  standalonePostId,
  standaloneMentionKey,
  TagsBlockedError,
  type PublishStore,
  type PublishHooks,
  type TagOneOptions,
} from "./bot-kit/publish/publisher.js";

function publishHooks(): PublishHooks {
  return {
    envSwitchOn,
    incrementSecurityEvent: (rule) => metrics.incrementSecurityEvent(rule),
    incrementReplies: (kind) => metrics.incrementReplies(kind),
    incrementMentions: (status) => metrics.incrementMentions(status),
    incrementAuthFailed: () => metrics.incrementAuthFailed(),
    scanOutboundText,
    secretDeclineReply: SECRET_DECLINE_REPLY,
    putReplyTags,
    putArtifactTag,
    deleteArtifactTag,
    isArtifactTagLabel,
    tagMaxAttempts: TAG_MAX_ATTEMPTS,
    tagVocabulary: REPLY_TAG_VOCABULARY,
  };
}

export async function enqueueStandalonePost(
  store: Store,
  opts: {
    content: string;
    kind: "short" | "long";
    attachments?: string[];
    collectionId?: string | null;
    approvedBy: string;
    categories?: string[];
    client?: { query: import("pg").Pool["query"] };
  },
): Promise<{ mentionKey: string; postId: string; inserted: boolean }> {
  return kitEnqueueStandalonePost(store, opts);
}

export async function enqueueCollectionUpsert(
  store: Store,
  opts: {
    title: string;
    description: string;
    itemUris: string[];
    layout?: import("./post.js").CollectionLayout;
    approvedBy: string;
  },
): Promise<{ mentionKey: string; postId: string; inserted: boolean; content: string }> {
  return kitEnqueueCollectionUpsert(store, opts);
}

export async function enqueuePostTag(
  store: Store,
  opts: { postUri: string; label: string; approvedBy: string },
): Promise<{ inserted: boolean }> {
  return kitEnqueuePostTag(store, opts, isArtifactTagLabel);
}

export async function revokePostTag(
  store: Store,
  transport: Transport,
  opts: { postUri: string; label: string; approvedBy: string },
): Promise<void> {
  return kitRevokePostTag(store, transport, opts, publishHooks());
}

export async function tagOne(
  store: Store,
  transport: Transport,
  cfg: Config,
  row: { id: number; mention_key: string; reply_uri: string; categories: string[] },
  opts?: { stopping?: () => boolean },
): Promise<void> {
  return kitTagOne(store, transport, cfg, row, { ...opts, tagVocabulary: REPLY_TAG_VOCABULARY }, publishHooks());
}

export async function applyArtifactTagOne(
  store: Store,
  transport: Transport,
  cfg: Config,
  row: { id: number; post_uri: string; label: string; approved_by?: string | null },
): Promise<void> {
  return kitApplyArtifactTagOne(store, transport, cfg, row, publishHooks());
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
    approved_by?: string | null;
  },
): Promise<void> {
  return kitPublishOne(store, transport, cfg, row, publishHooks());
}

export async function runPublish(cfg: Config, opts?: { transport?: Transport }): Promise<() => Promise<void>> {
  return kitRunPublish(cfg, {
    createStore: (url) => new Store(url),
    listenHealth,
    listenAdmin: (port, token, store, host) => listenAdmin(port, token, store as Store, host),
    closeServer,
    hooks: publishHooks(),
    transport: opts?.transport,
  });
}
