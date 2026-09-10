import type pg from "pg";
import { PHASE0_BRAIN } from "../pubchi-schemas/index.js";
import { assertNoKeyMaterial } from "../bot-kit/security/keys.js";
import { createBrain } from "../bot-kit/brain/create.js";
import type { Brain, BrainId } from "../bot-kit/brain/types.js";
import { queryNlq, type NlqServiceOptions } from "../bot-kit/nlq/service.js";
import type { IntentRegexTables } from "../bot-kit/nlq/intent.js";
import { ScoutClient } from "../bot-kit/scout/client.js";
import { Nexus } from "../bot-kit/nexus/nexus.js";
import { scoutSwitchBlocked } from "../bot-kit/scout/budget.js";
import { postgresComposedQueryBudget } from "../bot-kit/scout/budget.js";
import { log } from "../bot-kit/log.js";
import { ensureScoutSchemaCache, refreshScoutSchema, stopScoutSchemaCache } from "../bot-kit/scout/schema-cache.js";
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
import { postgresNonceStore, sweepExpiredNonces } from "./nonce.js";
import { createTenantResolver } from "./tenant.js";
import { memoryTokenBucket, postgresTokenBudget } from "./budget.js";
import { listenPubchi, type PubchiMode } from "./http.js";
import { pubchiComposerCohort, pubchiPlannerCohort, pubchiPlannerEnabled } from "./env.js";
import {
  pubchiKnowledgeEnabled,
  pubchiWebEnabled,
  parsePubchiKnowledgePerOwnerDay,
  parsePubchiWebGlobalDay,
  parsePubchiWebPerOwnerDay,
  assertPubchiExternalConfig,
} from "./env.js";
import { createRemoteKnowledgeClient } from "../bot-kit/knowledge/remote-client.js";
import { postgresPubchiKnowledgeBudget } from "./knowledge-budget.js";
import { createPubchiWebSearch, postgresPubchiWebBudget } from "./web-search.js";
import type { WebToolsConfig } from "../bot-kit/web/web-config.js";

export const NONCE_SWEEP_MS = 60_000;

/** Interval tick: a DB blip must not become an unhandled rejection. */
export function sweepExpiredNoncesSafe(pool: Pick<pg.Pool, "query">): Promise<void> {
  return sweepExpiredNonces(pool).then(() => undefined).catch((err) => {
    log.debug({ err }, "nonce sweep failed");
  });
}

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
} & Partial<Pick<WebToolsConfig, "webProvider" | "braveApiKey">>;

export async function runPubchiProcess(opts: {
  mode: PubchiMode;
  cfg: PubchiProcessConfig;
  pool: pg.Pool;
  tables: IntentRegexTables;
  storeSwitchOn?: () => Promise<boolean>;
  feedSwitchOn?: () => Promise<boolean>;
  readiness?: () => Promise<{ config: boolean; database: boolean; migrations: boolean }>;
  brain?: Brain;
}): Promise<() => Promise<void>> {
  assertNoKeyMaterial();
  assertPubchiExternalConfig({
    knowledgeEnabled: pubchiKnowledgeEnabled(),
    knowledgeUrl: process.env.PUBCHI_KNOWLEDGE_URL,
    knowledgeToken: process.env.PUBCHI_KNOWLEDGE_TOKEN,
    webEnabled: pubchiWebEnabled(),
    webProvider: opts.cfg.webProvider ?? process.env.PUBCHI_WEB_PROVIDER,
    braveApiKey: opts.cfg.braveApiKey ?? process.env.BRAVE_API_KEY,
    modelApiKey: opts.cfg.modelApiKey,
  });
  const bind = pubchiBind(opts.cfg.pubchiBind ?? process.env.PUBCHI_BIND);
  if (!isLoopbackBind(bind)) assertPubchiBindAllowed(bind);

  const brain =
    opts.brain ??
    createBrain({
      id: opts.cfg.brain,
      model: PHASE0_BRAIN.model_id,
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
  const composedQueryBudget = postgresComposedQueryBudget(opts.pool);
  const knowledge = pubchiKnowledgeEnabled() && process.env.PUBCHI_KNOWLEDGE_URL && process.env.PUBCHI_KNOWLEDGE_TOKEN
    ? createRemoteKnowledgeClient({
        baseUrl: process.env.PUBCHI_KNOWLEDGE_URL,
        token: process.env.PUBCHI_KNOWLEDGE_TOKEN,
      })
    : undefined;
  const knowledgeBudget = postgresPubchiKnowledgeBudget(opts.pool, { ownerDailyCap: parsePubchiKnowledgePerOwnerDay() });
  const webBudget = postgresPubchiWebBudget(opts.pool, {
    ownerDailyCap: parsePubchiWebPerOwnerDay(),
    globalDailyCap: parsePubchiWebGlobalDay(),
  });
  const webSearchForOwner = pubchiWebEnabled()
    ? (owner: string) => createPubchiWebSearch({
        providerConfig: {
          ...opts.cfg,
          webProvider: opts.cfg.webProvider ?? "off",
          braveApiKey: opts.cfg.braveApiKey ?? process.env.BRAVE_API_KEY,
          webTimeoutMs: 2_500,
          webPerMentionCap: 1,
          webDailyCeiling: parsePubchiWebGlobalDay(),
          modelBaseUrl: opts.cfg.modelBaseUrl,
          modelApiKey: opts.cfg.modelApiKey,
          webEnabled: true,
        },
        owner,
        budget: webBudget,
      })
    : undefined;
  const bucket = memoryTokenBucket({
    ratePerSec: parseBucketRatePerSec(process.env.PUBCHI_BUCKET_RATE_PER_SEC),
    burst: parseBucketBurst(process.env.PUBCHI_BUCKET_BURST),
  });
  const client = new ScoutClient(opts.cfg, opts.pool);
  const nexus = new Nexus(opts.cfg.nexusUrl, 5_000);
  const storeSwitchOn = opts.storeSwitchOn ?? (async () => false);
  const switchBlocked = () => scoutSwitchBlocked(storeSwitchOn);
  // Planner fails closed unless the live Scout schema is loaded. NLQ does the
  // same await+cache; without it every who-tagged-me maps to UPSTREAM_UNAVAILABLE.
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
  const nlqOpts: NlqServiceOptions = {
    cfg: opts.cfg,
    pool: opts.pool,
    tables: opts.tables,
    storeSwitchOn,
    client,
    brain,
  };

  const sweeper = setInterval(() => {
    void sweepExpiredNoncesSafe(opts.pool);
  }, NONCE_SWEEP_MS);
  sweeper.unref();

  const listening = await listenPubchi({
    mode: opts.mode,
    port: opts.cfg.pubchiPort ?? parsePubchiPort(process.env.PUBCHI_PORT),
    bind,
    nonceForAsker: (asker) => postgresNonceStore(opts.pool, asker),
    tenants,
    budget,
    bucket,
    nlq: queryNlq,
    nlqOpts,
    nexus,
    brain,
    knowledge,
    knowledgeBudget,
    webSearchForOwner,
    composedQueryBudget,
    plannerCohort: (owner) => pubchiPlannerEnabled() && pubchiPlannerCohort(owner),
    composerCohort: pubchiComposerCohort,
    feedSwitchOn: opts.feedSwitchOn,
    readiness: opts.readiness,
  });

  return async () => {
    clearInterval(sweeper);
    await new Promise<void>((resolve) => listening.server.close(() => resolve()));
    stopScoutSchemaCache();
  };
}
