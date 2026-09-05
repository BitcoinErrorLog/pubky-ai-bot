import { Store } from "./db.js";
import type { Config } from "./config.js";
import { log } from "./log.js";
import { parseCollectionLayout } from "./post.js";
import { enqueueCollectionUpsert } from "./publish.js";
import { JEB_COLLECTION_RULES, ruleByKey } from "./bot-kit/collections/rules.js";
import { rebuildCollection, reconcileCollections, seedCollectionRules } from "./collections-maintain.js";

function argValue(flag: string, argv: string[]): string | undefined {
  const i = argv.indexOf(flag);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("-")) return argv[i + 1];
  return undefined;
}

function argvAfterRole(argv: string[]): string[] {
  const roleIdx = argv.indexOf("--role");
  return roleIdx >= 0 ? argv.slice(roleIdx + 2) : argv.slice(2);
}

export async function runCollectionsCli(cfg: Config, argv = process.argv): Promise<{ ok: boolean; lines: string[] }> {
  const afterRole = argvAfterRole(argv);
  const action = afterRole[0];
  const store = new Store(cfg.databaseUrl);
  await store.migrate();
  const lines: string[] = [];
  try {
    if (action === "list") {
      await seedCollectionRules(store);
      const rules = await store.listCollectionRules();
      for (const rule of rules) {
        const items = await store.listCollectionItemUris(rule.collection_key);
        const latest = await store.latestCollectionRequest(rule.collection_key);
        const match = [rule.match_series, rule.match_self_tag].filter(Boolean).join(",") || "long";
        lines.push(`${rule.collection_key}\t${rule.title}\t${match}\titems=${items.length}\t${latest?.status ?? "unseeded"}`);
        log.info({ uri: rule.collection_key, label: rule.title }, "collection");
      }
      lines.push(`count=${rules.length}`);
      return { ok: true, lines };
    }
    if (action === "show") {
      const key = afterRole[1];
      if (!key) return { ok: false, lines: ["usage: --role collections show <key>"] };
      await seedCollectionRules(store);
      const rule = (await store.getCollectionRule(key)) ?? ruleByKey(key);
      if (!rule) return { ok: false, lines: [`unknown collection ${key}`] };
      const items = await store.listCollectionItemUris(key);
      const latest = await store.latestCollectionRequest(key);
      lines.push(JSON.stringify({ rule, items, latest }, null, 2));
      return { ok: true, lines };
    }
    if (action === "rebuild") {
      const key = afterRole[1];
      if (!key) return { ok: false, lines: ["usage: --role collections rebuild <key>"] };
      const out = await rebuildCollection(store, key);
      lines.push(`rebuild ${key} items=${out.items.length} queued=${out.queued}`);
      return { ok: true, lines };
    }
    if (action === "reconcile") {
      const out = await reconcileCollections(store);
      lines.push(`created=${out.created.join(",") || "-"} skipped=${out.skipped.length}`);
      return { ok: true, lines };
    }
    if (action === "upsert") {
      const title = argValue("--title", argv);
      const description = argValue("--description", argv) ?? "";
      const itemsRaw = argValue("--items", argv);
      const by = argValue("--by", argv);
      const layoutRaw = argValue("--layout", argv);
      if (!title || !itemsRaw || !by) {
        return { ok: false, lines: ["usage: --role collections upsert --title <t> --description <d> --items <uri,...> --by <handle>"] };
      }
      const itemUris = itemsRaw.split(",").map((s) => s.trim()).filter(Boolean);
      const queued = await enqueueCollectionUpsert(store, {
        title,
        description,
        itemUris,
        layout: parseCollectionLayout(layoutRaw),
        approvedBy: by,
      });
      log.info({ uri: queued.postId, label: title }, "collection queued");
      lines.push(queued.inserted ? `queued ${queued.postId}` : `already queued ${queued.postId}`);
      return { ok: true, lines };
    }
    return {
      ok: false,
      lines: [
        "usage: --role collections list|show <key>|rebuild <key>|reconcile|upsert",
        `known keys: ${JEB_COLLECTION_RULES.map((r) => r.collection_key).join(", ")}`,
      ],
    };
  } finally {
    await store.close();
  }
}
