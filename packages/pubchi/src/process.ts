import type pg from "pg";
import { PHASE0_BRAIN } from "../pubchi-schemas/index.js";
import { assertNoKeyMaterial } from "../bot-kit/security/keys.js";
import { createBrain } from "../bot-kit/brain/create.js";
import type { Brain, BrainId } from "../bot-kit/brain/types.js";
import { createPubchiBrainServe } from "./brain-serve.js";
import { queryNlq, type NlqServiceOptions } from "../bot-kit/nlq/service.js";
import type { IntentRegexTables } from "../bot-kit/nlq/intent.js";
import { ScoutClient } from "../bot-kit/scout/client.js";
import { createScoutTools } from "../bot-kit/scout/tools.js";
import { Nexus } from "../bot-kit/nexus/nexus.js";
import { scoutSwitchBlocked } from "../bot-kit/scout/budget.js";
import { postgresC5ScoutBudget, postgresComposedQueryBudget } from "../bot-kit/scout/budget.js";
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
import { scoutMentionKey } from "./env.js";
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
import {
  assertWebSearchConfig,
  createPubchiWebSearch,
  postgresPubchiWebBudget,
  type PubchiWebConfig,
  type PubchiWebSearchOptions,
  type PubchiWebTelemetry,
} from "./web-search.js";
import type { WebToolsConfig } from "../bot-kit/web/web-config.js";
import { KIMI_SEARCH_HTTP_TIMEOUT_MS } from "../bot-kit/web/kimi.js";

export const NONCE_SWEEP_MS = 60_000;
export const PUBCHI_BRAVE_HTTP_TIMEOUT_MS = 2_500;

export function pubchiWebProviderTimeoutMs(provider: PubchiWebConfig["webProvider"]): number {
  return provider === "kimi" ? KIMI_SEARCH_HTTP_TIMEOUT_MS : PUBCHI_BRAVE_HTTP_TIMEOUT_MS;
}

export function logPubchiWebCost(event: PubchiWebTelemetry): void {
  if (event.provider !== "kimi" || event.cost_usd <= 0) return;
  log.info(
    {
      event: "pubchi_web_cost",
      provider: event.provider,
      usd: event.cost_usd,
      owner_hash: event.owner_key_hash,
      result_count: event.result_count,
      duration_ms: event.ms,
    },
    "pubchi web search cost",
  );
}

export function createLoggedPubchiWebSearch(
  opts: Omit<PubchiWebSearchOptions, "telemetry">,
): ReturnType<typeof createPubchiWebSearch> {
  return createPubchiWebSearch({ ...opts, telemetry: logPubchiWebCost });
}

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
} & Partial<WebToolsConfig>;

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
  const configuredPubchiWebProvider =
    process.env.PUBCHI_WEB_PROVIDER?.trim().toLowerCase() || "off";
  const braveApiKey = opts.cfg.braveApiKey ?? process.env.JEB_BRAVE_API_KEY;
  assertPubchiExternalConfig({
    knowledgeEnabled: pubchiKnowledgeEnabled(),
    knowledgeUrl: process.env.PUBCHI_KNOWLEDGE_URL,
    knowledgeToken: process.env.PUBCHI_KNOWLEDGE_TOKEN,
    webEnabled: pubchiWebEnabled(),
    webProvider: configuredPubchiWebProvider,
    braveApiKey,
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
  const scoutBudget = postgresC5ScoutBudget(opts.pool);
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
  const webProvider = configuredPubchiWebProvider as PubchiWebConfig["webProvider"];
  const webProviderConfig: PubchiWebConfig & { webEnabled: boolean } = {
    ...opts.cfg,
    webProvider,
    braveApiKey,
    webTimeoutMs: pubchiWebProviderTimeoutMs(webProvider),
    webPerMentionCap: 1,
    webDailyCeiling: parsePubchiWebGlobalDay(),
    webAllowedAuthorities: opts.cfg.webAllowedAuthorities ?? new Set(["S", "A", "B"]),
    webFetchMaxChars: opts.cfg.webFetchMaxChars ?? 12_000,
    webPriceBasicUsd: opts.cfg.webPriceBasicUsd ?? 0.002,
    webPriceProUsd: opts.cfg.webPriceProUsd ?? 0.003,
    webPriceFetchUsd: opts.cfg.webPriceFetchUsd ?? 0.002,
    modelBaseUrl: opts.cfg.modelBaseUrl,
    modelApiKey: opts.cfg.modelApiKey,
    webEnabled: true,
  };
  if (pubchiWebEnabled()) {
    const validatedWebProviderConfig = assertWebSearchConfig(webProviderConfig);
    createPubchiWebSearch({
      providerConfig: validatedWebProviderConfig,
      owner: "__pubchi_boot_validation__",
      budget: webBudget,
    });
  }
  const webSearchForOwner = pubchiWebEnabled()
    ? (owner: string) => createLoggedPubchiWebSearch({
        providerConfig: assertWebSearchConfig(webProviderConfig),
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
    scoutForTenant: (tenant, now) => {
      const tools = createScoutTools({
        cfg: opts.cfg,
        pool: opts.pool,
        client,
        mentionKey: scoutMentionKey(tenant.bot, tenant.owner),
        persistent: true,
        storeSwitchOn,
        nowMs: now > 100_000_000_000 ? now : now * 1000,
      });
      return {
        scout_get_thread: tools.scout_get_thread,
        get_identity_summary: tools.get_identity_summary,
      };
    },
    brain,
    resolveBrain: createPubchiBrainServe({
      deploymentBrain: brain,
      hostedModel: PHASE0_BRAIN.model_id,
      hostedApiKey: opts.cfg.modelApiKey,
      hostedBaseUrl: opts.cfg.modelBaseUrl,
      hostedTemperature: opts.cfg.modelTemperature,
      selfHostedApiKey: process.env.PUBCHI_SELF_HOSTED_BRAIN_API_KEY,
      egressDangerous: opts.cfg.brainEgressDangerous,
    }),
    scoutBudget,
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
