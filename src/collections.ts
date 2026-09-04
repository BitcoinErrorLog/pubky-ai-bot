import { Store } from "./db.js";
import type { Config } from "./config.js";
import { log } from "./log.js";
import { parseCollectionLayout } from "./post.js";
import { enqueueCollectionUpsert } from "./publish.js";

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
      const rows = await store.listCollectionRequests();
      for (const row of rows) {
        let title = "";
        try {
          const env = JSON.parse(row.content) as { name?: unknown };
          title = typeof env.name === "string" ? env.name : "";
        } catch {
          title = "";
        }
        lines.push(`${row.status}\t${row.replace_post_id ?? ""}\t${title}`);
        log.info({ uri: row.replace_post_id, label: title }, "collection");
      }
      lines.push(`count=${rows.length}`);
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
    return { ok: false, lines: ["usage: --role collections upsert|list"] };
  } finally {
    await store.close();
  }
}
