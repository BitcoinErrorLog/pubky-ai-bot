import type pg from "pg";
import { assertNoKeyMaterial } from "../security/keys.js";
import { scoutSwitchBlocked } from "../scout/budget.js";
import { ScoutClient } from "../scout/client.js";
import { ensureScoutSchemaCache, refreshScoutSchema, stopScoutSchemaCache } from "../scout/schema-cache.js";
import type { ScoutToolsConfig } from "../scout/scout-config.js";
import type { IntentRegexTables } from "./intent.js";
import { assertNlqBindAllowed, isLoopbackBind, listenNlq, nlqBind, parseNlqDailyQueries, parseNlqPort } from "./http.js";

export type NlqProcessConfig = ScoutToolsConfig & {
  nexusUrl?: string;
  nlqPort?: number;
  nlqBind?: string;
  nlqDailyQueries?: number;
  scoutSchemaRefreshMs?: number;
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
  const bind = nlqBind(opts.cfg.nlqBind ?? process.env.JEB_NLQ_BIND);
  if (!isLoopbackBind(bind)) {
    assertNlqBindAllowed(bind);
  }
  const client = new ScoutClient(opts.cfg, opts.pool);
  const storeSwitchOn = opts.storeSwitchOn ?? (async () => false);
  const switchBlocked = () => scoutSwitchBlocked(storeSwitchOn);
  if (!(await switchBlocked())) {
    await refreshScoutSchema(client);
  }
  ensureScoutSchemaCache(
    {
      scoutUrl: opts.cfg.scoutUrl,
      scoutTimeoutMs: opts.cfg.scoutTimeoutMs,
      scoutSchemaRefreshMs: opts.cfg.scoutSchemaRefreshMs ?? 21_600_000,
    },
    client,
    { switchBlocked },
  );
  const listening = await listenNlq({
    cfg: opts.cfg,
    pool: opts.pool,
    tables: opts.tables,
    storeSwitchOn,
    client,
    nlqDailyQueries: opts.cfg.nlqDailyQueries ?? parseNlqDailyQueries(process.env.JEB_NLQ_DAILY_QUERIES),
    port: opts.cfg.nlqPort ?? parseNlqPort(process.env.JEB_NLQ_PORT),
    bind,
  });
  return async () => {
    await new Promise<void>((resolve) => listening.server.close(() => resolve()));
    stopScoutSchemaCache();
  };
}
