import type pg from "pg";
import { assertNoKeyMaterial } from "../bot-kit/security/keys.js";
import { createBrain } from "../bot-kit/brain/create.js";
import type { Brain, BrainId } from "../bot-kit/brain/types.js";
import { queryNlq, type NlqServiceOptions } from "../bot-kit/nlq/service.js";
import type { IntentRegexTables } from "../bot-kit/nlq/intent.js";
import { ScoutClient } from "../bot-kit/scout/client.js";
import {
  assertPubchiBindAllowed,
  isLoopbackBind,
  parseBucketBurst,
  parseBucketRatePerSec,
  parseDailyTokenCeiling,
  parsePerRequestTokenCap,
  parsePubchiPort,
  pubchiBind,
} from "./env.js";
import { createPublicHomeserverReader } from "./homeserver-read.js";
import { postgresNonceStore } from "./nonce.js";
import { createTenantResolver } from "./tenant.js";
import { memoryTokenBucket, postgresTokenBudget } from "./budget.js";
import { listenPubchi } from "./http.js";

export type PubchiProcessConfig = {
  databaseUrl: string;
  nexusUrl: string;
  scoutUrl: string;
  scoutEnabled: boolean;
  scoutTimeoutMs: number;
  scoutLimitMax: number;
  scoutRawEnabled: boolean;
  scoutPerMentionCap: number;
  scoutDailyCeiling: number;
  scoutRawPerUserDaily: number;
  scoutRawGlobalDaily: number;
  scoutProfilePropMax: number;
  scoutClaimantCap: number;
  scoutMaxQps: number;
  scoutSchemaRefreshMs?: number;
  pubchiPort?: number;
  pubchiBind?: string;
  brain: BrainId;
  model: string;
  modelApiKey?: string;
  modelBaseUrl?: string;
  modelTemperature?: number;
  brainEgressDangerous: boolean;
  testnet?: boolean;
};

export async function runPubchiProcess(opts: {
  cfg: PubchiProcessConfig;
  pool: pg.Pool;
  tables: IntentRegexTables;
  storeSwitchOn?: () => Promise<boolean>;
  brain?: Brain;
}): Promise<() => Promise<void>> {
  assertNoKeyMaterial();
  const bind = pubchiBind(opts.cfg.pubchiBind ?? process.env.PUBCHI_BIND);
  if (!isLoopbackBind(bind)) assertPubchiBindAllowed(bind);

  const brain =
    opts.brain ??
    createBrain({
      id: opts.cfg.brain,
      model: opts.cfg.model,
      apiKey: opts.cfg.modelApiKey,
      baseUrl: opts.cfg.modelBaseUrl,
      temperature: opts.cfg.modelTemperature,
      egressDangerous: opts.cfg.brainEgressDangerous,
    });

  const reader = createPublicHomeserverReader({ testnet: opts.cfg.testnet === true });
  const tenants = createTenantResolver(reader);
  const dailyCeiling = parseDailyTokenCeiling(process.env.PUBCHI_DAILY_TOKEN_CEILING);
  const perRequestCap = parsePerRequestTokenCap(process.env.PUBCHI_PER_REQUEST_TOKEN_CAP);
  const budget = postgresTokenBudget(opts.pool, { dailyCeiling, perRequestCap });
  const bucket = memoryTokenBucket({
    ratePerSec: parseBucketRatePerSec(process.env.PUBCHI_BUCKET_RATE_PER_SEC),
    burst: parseBucketBurst(process.env.PUBCHI_BUCKET_BURST),
  });
  const client = new ScoutClient(opts.cfg, opts.pool);
  const storeSwitchOn = opts.storeSwitchOn ?? (async () => false);
  const nlqOpts: NlqServiceOptions = {
    cfg: opts.cfg,
    pool: opts.pool,
    tables: opts.tables,
    storeSwitchOn,
    client,
  };

  const listening = await listenPubchi({
    port: opts.cfg.pubchiPort ?? parsePubchiPort(process.env.PUBCHI_PORT),
    bind,
    nonceForAsker: (asker) => postgresNonceStore(opts.pool, asker),
    tenants,
    budget,
    bucket,
    nlq: queryNlq,
    nlqOpts,
    brain,
  });

  return async () => {
    await new Promise<void>((resolve) => listening.server.close(() => resolve()));
  };
}
