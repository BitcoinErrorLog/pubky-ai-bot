import {
  appendItemIdempotent,
  JEB_COLLECTION_RULES,
  matchingCollectionKeys,
  ruleByKey,
  type CollectionRule,
  type PublishedPost,
} from "./bot-kit/collections/rules.js";
import { collectionItemLimit } from "./bot-kit/publish/post.js";
import type { Store } from "./db.js";
import { log } from "./log.js";
import { enqueueCollectionUpsert } from "./publish.js";
import { envSwitchOn } from "./switches.js";

export const COLLECTIONS_APPROVER = "jeb";

export async function collectionsBlocked(store: Pick<Store, "switchOn">): Promise<boolean> {
  return envSwitchOn("collections") || envSwitchOn("global") || (await store.switchOn("collections"));
}

export function ruleFromRow(row: {
  collection_key: string;
  title: string;
  description: string;
  match_series: string | null;
  match_self_tag: string | null;
}): CollectionRule {
  return {
    collection_key: row.collection_key,
    title: row.title,
    description: row.description,
    match: {
      ...(row.match_series ? { series: row.match_series } : {}),
      ...(row.match_self_tag ? { self_tag: row.match_self_tag } : {}),
    },
  };
}

export async function seedCollectionRules(store: Store): Promise<number> {
  return store.seedCollectionRules(JEB_COLLECTION_RULES);
}

/** Ensure every seeded collection has a queued/published envelope (empty items allowed). */
export async function reconcileCollections(store: Store): Promise<{ created: string[]; skipped: string[] }> {
  if (await collectionsBlocked(store)) {
    log.info({ event: "collections_reconcile" }, "collections switch on; skip reconcile");
    return { created: [], skipped: JEB_COLLECTION_RULES.map((r) => r.collection_key) };
  }
  await seedCollectionRules(store);
  const created: string[] = [];
  const skipped: string[] = [];
  for (const rule of JEB_COLLECTION_RULES) {
    const items = await store.listCollectionItemUris(rule.collection_key);
    const existing = await store.latestCollectionRequest(rule.collection_key);
    if (existing && (existing.status === "queued" || existing.status === "retry" || existing.status === "publishing" || existing.status === "published")) {
      skipped.push(rule.collection_key);
      continue;
    }
    try {
      await enqueueCollectionUpsert(store, {
        title: rule.title,
        description: rule.description,
        itemUris: items.slice(-collectionItemLimit()),
        layout: "list",
        approvedBy: COLLECTIONS_APPROVER,
      });
      created.push(rule.collection_key);
    } catch (e) {
      log.warn({ err: String(e), rule: rule.collection_key }, "collections reconcile: rule failed");
      skipped.push(rule.collection_key);
    }
  }
  return { created, skipped };
}

export async function recordPublishedStandalone(
  store: Store,
  row: {
    uri: string;
    postId: string;
    kind: "short" | "long";
    content: string;
    selfTags: string[];
    series?: string | null;
    publishRequestId: number;
  },
): Promise<void> {
  await store.upsertPublished({
    uri: row.uri,
    postId: row.postId,
    kind: row.kind,
    content: row.content,
    selfTags: row.selfTags,
    series: row.series ?? null,
    publishRequestId: row.publishRequestId,
  });
}

export async function appendPublishedToCollections(store: Store, post: PublishedPost): Promise<string[]> {
  if (await collectionsBlocked(store)) return [];
  await seedCollectionRules(store);
  const keys = matchingCollectionKeys(post);
  const appended: string[] = [];
  for (const key of keys) {
    const changed = await appendUriToCollection(store, key, post.uri);
    if (changed) appended.push(key);
  }
  return appended;
}

export async function appendUriToCollection(store: Store, key: string, uri: string): Promise<boolean> {
  const rule = (await store.getCollectionRule(key)) ?? ruleByKey(key);
  if (!rule) throw new Error(`unknown collection ${key}`);
  const current = await store.listCollectionItemUris(key);
  const next = appendItemIdempotent(current, uri, collectionItemLimit());
  if (!next.appended) return false;
  await store.replaceCollectionItems(key, next.items);
  await enqueueCollectionUpsert(store, {
    title: rule.title,
    description: rule.description,
    itemUris: next.items,
    layout: "list",
    approvedBy: COLLECTIONS_APPROVER,
  });
  return true;
}

export async function rebuildCollection(store: Store, key: string): Promise<{ items: string[]; queued: boolean }> {
  if (await collectionsBlocked(store)) {
    throw new Error("collections switch is on");
  }
  await seedCollectionRules(store);
  const rule = (await store.getCollectionRule(key)) ?? ruleByKey(key);
  if (!rule) throw new Error(`unknown collection ${key}`);
  const published = await store.listPublished();
  const items: string[] = [];
  for (const p of published) {
    if (matchingCollectionKeys(p, [rule]).length > 0) items.push(p.uri);
  }
  const capped = items.slice(-collectionItemLimit());
  await store.replaceCollectionItems(key, capped);
  const queued = await enqueueCollectionUpsert(store, {
    title: rule.title,
    description: rule.description,
    itemUris: capped,
    layout: "list",
    approvedBy: COLLECTIONS_APPROVER,
  });
  return { items: capped, queued: queued.inserted };
}
