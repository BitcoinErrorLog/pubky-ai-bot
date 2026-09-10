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
import { appendPublishedToCollections, recordPublishedStandalone, reconcileCollections } from "./collections-maintain.js";
import { JEB_PUBKY } from "./weekly/types.js";
import { listTrackedProjectsSafe, markWeeklyPublished, markWeeklyRecoveryPublished } from "./weekly/store.js";
import { assertKnowledgeEndpointConfig, listenKnowledge } from "./knowledge/http.js";

export {
  validatePublishShape,
  standalonePostId,
  standaloneMentionKey,
  TagsBlockedError,
  PersistedPostIdError,
  type PublishStore,
  type PublishHooks,
  type TagOneOptions,
} from "./bot-kit/publish/publisher.js";

/** Shared post-publish weekly side-effects. Both hook sets must call this. */
export async function markWeeklyRowsPublished(
  store: Store,
  mentionKey: string,
  uri: string,
): Promise<void> {
  await markWeeklyPublished(store.pool, mentionKey, uri);
  await markWeeklyRecoveryPublished(store.pool, mentionKey, uri);
}

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
    tagVocabulary: [],
    openTagPersonTokens: () => [JEB_PUBKY],
  };
}

export function storePublishHooks(store: Store): PublishHooks {
  return {
    ...publishHooks(),
    botRepliedTo: (uri) => store.botRepliedTo(uri),
    openTagPersonTokens: async () => {
      const tokens = new Set<string>([JEB_PUBKY]);
      try {
        const projects = await listTrackedProjectsSafe(store.pool);
        for (const p of projects) {
          for (const id of p.pubky_ids) tokens.add(id);
        }
      } catch {
        /* JEB_PUBKY alone still covers the production key */
      }
      return [...tokens];
    },
    weeklyOriginExists: async (mentionKey) => {
      const r = await store.pool.query(
        `SELECT 1 FROM weekly_posts WHERE mention_key = $1
         UNION ALL SELECT 1 FROM weekly_legacy_recoveries WHERE replacement_mention_key = $1 LIMIT 1`,
        [mentionKey],
      );
      return (r.rowCount ?? 0) > 0;
    },
    onStandalonePublished: async (info) => {
      await markWeeklyRowsPublished(store, info.mentionKey, info.uri);
    },
  };
}

export async function enqueueStandalonePost(
  store: Store,
  opts: {
    content: string;
    kind: "short" | "long";
    botPk?: string;
    attachments?: string[];
    collectionId?: string | null;
    approvedBy: string;
    categories?: string[];
    client?: { query: import("pg").Pool["query"] };
  },
): Promise<{ mentionKey: string; postId: string; inserted: boolean }> {
  return kitEnqueueStandalonePost(store, { ...opts, botPk: opts.botPk ?? JEB_PUBKY });
}

export async function enqueueCollectionUpsert(
  store: Store,
  opts: {
    botPk?: string;
    title: string;
    description: string;
    itemUris: string[];
    layout?: import("./post.js").CollectionLayout;
    approvedBy: string;
  },
): Promise<{ mentionKey: string; postId: string; inserted: boolean; content: string }> {
  return kitEnqueueCollectionUpsert(store, { ...opts, botPk: opts.botPk ?? JEB_PUBKY });
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
  return kitTagOne(store, transport, cfg, row, { ...opts, tagVocabulary: [] }, storePublishHooks(store));
}

export async function applyArtifactTagOne(
  store: Store,
  transport: Transport,
  cfg: Config,
  row: {
    id: number;
    post_uri: string;
    label: string;
    approved_by?: string | null;
    attempts?: number;
    created_at?: Date;
  },
): Promise<void> {
  return kitApplyArtifactTagOne(store, transport, cfg, row, storePublishHooks(store));
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
    categories?: string[];
  },
  hooks?: PublishHooks,
): Promise<void> {
  return kitPublishOne(store, transport, cfg, row, hooks ?? storePublishHooks(store));
}

export async function onRunPublishStandalonePublished(
  store: Store,
  info: {
    uri: string;
    postId: string;
    kind: "short" | "long";
    content: string;
    categories: string[];
    requestId: number;
    mentionKey: string;
  },
): Promise<void> {
  await recordPublishedStandalone(store, {
    uri: info.uri,
    postId: info.postId,
    kind: info.kind,
    content: info.content,
    selfTags: info.categories,
    publishRequestId: info.requestId,
  });
  await appendPublishedToCollections(store, {
    uri: info.uri,
    kind: info.kind,
    self_tags: info.categories,
  });
  await markWeeklyRowsPublished(store, info.mentionKey, info.uri);
}

export function createRunPublishHooks(getStore: () => Store | null): PublishHooks {
  return {
    ...publishHooks(),
    botRepliedTo: async (postUri) => {
      const store = getStore();
      if (!store) return false;
      return store.botRepliedTo(postUri);
    },
    onStandalonePublished: async (info) => {
      const store = getStore();
      if (!store) return;
      await onRunPublishStandalonePublished(store, info);
    },
    openTagPersonTokens: async () => {
      const tokens = new Set<string>([JEB_PUBKY]);
      const store = getStore();
      if (store) {
        try {
          const projects = await listTrackedProjectsSafe(store.pool);
          for (const p of projects) {
            for (const id of p.pubky_ids) tokens.add(id);
          }
        } catch {
          /* JEB_PUBKY alone still covers the production key */
        }
      }
      return [...tokens];
    },
    weeklyOriginExists: async (mentionKey) => {
      const store = getStore();
      if (!store) return false;
      const r = await store.pool.query(
        `SELECT 1 FROM weekly_posts WHERE mention_key = $1
         UNION ALL SELECT 1 FROM weekly_legacy_recoveries WHERE replacement_mention_key = $1 LIMIT 1`,
        [mentionKey],
      );
      return (r.rowCount ?? 0) > 0;
    },
  };
}

export async function runPublish(cfg: Config, opts?: { transport?: Transport }): Promise<() => Promise<void>> {
  let loopStore: Store | null = null;
  let knowledgeServer: import("node:http").Server | null = null;
  const hooks = createRunPublishHooks(() => loopStore);
  const stop = await kitRunPublish(cfg, {
    createStore: (url) => new Store(url),
    listenHealth,
    listenAdmin: (port, token, store, host) => listenAdmin(port, token, store as Store, host, cfg),
    closeServer,
    hooks,
    transport: opts?.transport,
    onStart: async (store) => {
      loopStore = store as Store;
      await reconcileCollections(loopStore);
      const enabled = process.env.JEB_KNOWLEDGE_ENDPOINT_ENABLED === "1";
      const token = process.env.PUBCHI_KNOWLEDGE_TOKEN?.trim();
      assertKnowledgeEndpointConfig(enabled, token);
      if (enabled) {
        knowledgeServer = listenKnowledge({
          pool: loopStore.pool,
          token: token!,
          privateHost: process.env.JEB_KNOWLEDGE_PRIVATE_HOST?.trim() || "jeb.railway.internal",
          bind: process.env.JEB_KNOWLEDGE_BIND?.trim() || "::",
          port: Number(process.env.JEB_KNOWLEDGE_PORT ?? "8091"),
        });
      }
    },
  });
  return async () => {
    if (knowledgeServer) {
      await new Promise<void>((resolve) => knowledgeServer!.close(() => resolve()));
      knowledgeServer = null;
    }
    await stop();
  };
}
