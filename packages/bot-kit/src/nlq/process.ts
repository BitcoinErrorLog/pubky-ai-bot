import type pg from "pg";
import { assertNoKeyMaterial } from "../security/keys.js";
import { ScoutClient } from "../scout/client.js";
import { refreshScoutSchema, stopScoutSchemaCache } from "../scout/schema-cache.js";
import type { ScoutToolsConfig } from "../scout/scout-config.js";
import type { IntentRegexTables } from "./intent.js";
import { listenNlq, nlqBind } from "./http.js";

export type NlqProcessConfig = ScoutToolsConfig & {
  nexusUrl?: string;
  nlqPort?: number;
  nlqBind?: string;
};

/**
 * Thin NL query process: no key material, no PublishStore, Scout tools only
 * through createScoutTools (via queryNlq).
 */
export async function runNlqProcess(opts: {
  cfg: NlqProcessConfig;
  pool: pg.Pool;
  tables: IntentRegexTables;
  storeSwitchOn?: () => Promise<boolean>;
}): Promise<() => Promise<void>> {
  assertNoKeyMaterial();
  const client = new ScoutClient(opts.cfg, opts.pool);
  await refreshScoutSchema(client);
  const listening = await listenNlq({
    cfg: opts.cfg,
    pool: opts.pool,
    tables: opts.tables,
    storeSwitchOn: opts.storeSwitchOn,
    client,
    port: opts.cfg.nlqPort ?? Number(process.env.JEB_NLQ_PORT || 3014),
    bind: nlqBind(opts.cfg.nlqBind ?? process.env.JEB_NLQ_BIND),
  });
  return async () => {
    await new Promise<void>((resolve) => listening.server.close(() => resolve()));
    stopScoutSchemaCache();
  };
}
