import { z } from "zod";
import { secretFromEnv } from "./keys.js";
import { log } from "./log.js";
import { SECRET_SCRUB_RULES } from "./secret-scrub.js";

const schema = z.object({
  nexusUrl: z.string().url(),
  homeserverPk: z.string(),
  signupToken: z.string().optional(),
  secretKeyHex: z.string().regex(/^[0-9a-f]{64}$/),
  databaseUrl: z.string().min(1),
  cannedReply: z.string().optional(),
  modelDelayMs: z.number().nonnegative(),
  maxRepliesPerThread: z.number().int().positive(),
  maxTurnsPerUserPerThread: z.number().int().positive(),
  maxPerUserPerHour: z.number().int().positive(),
  maxAgeMinutes: z.number().nonnegative(),
  pollMs: z.number().positive(),
  model: z.string().min(1),
  modelBaseUrl: z.string().url().optional(),
  modelApiKey: z.string().optional(),
  modelTimeoutMs: z.number().positive(),
  answerBudgetMs: z.number().positive(),
  replyDeadlineMs: z.number().positive(),
  modelTemperature: z.number().min(0).max(2).optional(),
  dailyTokenBudget: z.number().int().positive(),
  userDailyTokenBudget: z.number().int().positive(),
  blocklist: z.set(z.string()),
  knownBots: z.set(z.string()),
  disabledEnv: z.boolean(),
  port: z.number().int().positive().optional(),
  adminPort: z.number().int().positive().optional(),
  adminToken: z.string().optional(),
  testnet: z.boolean(),
  maxPublishAttempts: z.number().int().positive(),
  publishStaleMs: z.number().int().positive(),
  workMaxAttempts: z.number().int().positive(),
  workStaleMs: z.number().int().positive(),
  toolMaxSteps: z.number().int().positive(),
  role: z.enum([
    "all",
    "ingest",
    "reason",
    "publish",
    "ingest-knowledge",
    "requeue",
    "optouts",
    "drafts",
    "tags",
    "collections",
    "scout-canary",
    "nlq",
  ]),
  botPk: z.string().optional(),
  bind: z.string().min(1),
  reasonConcurrency: z.number().int().positive(),
  nexusTimeoutMs: z.number().positive(),
  scoutUrl: z.string().url(),
  scoutEnabled: z.boolean(),
  scoutTimeoutMs: z.number().positive(),
  scoutLimitMax: z.number().int().positive().max(100),
  scoutRawEnabled: z.boolean(),
  scoutPerMentionCap: z.number().int().positive(),
  scoutDailyCeiling: z.number().int().positive(),
  scoutRawPerUserDaily: z.number().int().positive(),
  scoutRawGlobalDaily: z.number().int().positive(),
  scoutProfilePropMax: z.number().int().positive(),
  scoutClaimantCap: z.number().int().positive(),
  scoutCanaryEnabled: z.boolean(),
  scoutCanaryIntervalMs: z.number().positive(),
  scoutCanaryUnknownThreshold: z.number().int().positive(),
  scoutMaxQps: z.number().positive(),
  scoutSchemaRefreshMs: z.number().positive(),
  appUrl: z.string().url(),
  webProvider: z.enum(["moonshot", "brave", "off"]),
  braveApiKey: z.string().optional(),
  webTimeoutMs: z.number().positive(),
  webPerMentionCap: z.number().int().positive(),
  webDailyCeiling: z.number().int().positive(),
  selfTags: z.boolean(),
  scrubDisabledRules: z.set(z.string()),
  /** USD list price per 1M input tokens (Kimi K3 family default). */
  modelPricePerMtokIn: z.number().nonnegative(),
  /** USD list price per 1M output tokens (Kimi K3 family default). */
  modelPricePerMtokOut: z.number().nonnegative(),
});

/** Code defaults shared with `docs/limits.md`, cost-bounds, and policy summary. */
export const DEFAULT_DAILY_TOKEN_BUDGET = 5_000_000;
export const DEFAULT_USER_DAILY_TOKEN_BUDGET = 600_000;
/** Moonshot Kimi K3 list price (USD / 1M input tokens). Same family as documented Kimi K2 list. */
export const DEFAULT_MODEL_PRICE_PER_MTOK_IN = 0.6;
/** Moonshot Kimi K3 list price (USD / 1M output tokens). */
export const DEFAULT_MODEL_PRICE_PER_MTOK_OUT = 2.5;

export type Config = z.infer<typeof schema>;

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`invalid ${name}`);
  return n;
}

function optNum(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`invalid ${name}`);
  return n;
}

function optUrl(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v || undefined;
}

export function parseRole(argv = process.argv): Config["role"] {
  const i = argv.indexOf("--role");
  if (i >= 0 && argv[i + 1]) {
    const r = argv[i + 1];
    if (
      r === "all" ||
      r === "ingest" ||
      r === "reason" ||
      r === "publish" ||
      r === "ingest-knowledge" ||
      r === "requeue" ||
      r === "optouts" ||
      r === "drafts" ||
      r === "tags" ||
      r === "collections" ||
      r === "scout-canary" ||
      r === "nlq"
    ) {
      return r;
    }
    throw new Error(`unknown --role ${r}`);
  }
  return "all";
}

function parseSafe(raw: unknown): Config {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  const bits = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
  throw new Error(`invalid config: ${bits.join("; ")}`);
}

export function warnLowProductionLimits(cfg: Pick<Config, "dailyTokenBudget" | "maxRepliesPerThread">): void {
  if (cfg.dailyTokenBudget < 1_000_000) {
    log.warn(
      { event: "config_warn", var: "JEB_DAILY_TOKEN_BUDGET", value: cfg.dailyTokenBudget },
      "unusually low; production defaults are 5000000",
    );
  }
  if (cfg.maxRepliesPerThread < 4) {
    log.warn(
      { event: "config_warn", var: "JEB_MAX_REPLIES_PER_THREAD", value: cfg.maxRepliesPerThread },
      "unusually low; production defaults are 12",
    );
  }
}

export function configFromProcessEnv(opts?: { requireSecret: boolean; role?: Config["role"] }): Config {
  const requireSecret = opts?.requireSecret ?? true;
  const secretKeyHex = requireSecret ? secretFromEnv() : "00".repeat(32);
  const portRaw = process.env.JEB_PORT ?? process.env.JEB_HEALTH_PORT;
  const adminPortRaw = process.env.JEB_ADMIN_PORT;
  const canned = process.env.JEB_CANNED_REPLY;
  const role = opts?.role ?? parseRole();
  // Per-role PG users: operators may wire JEB_DB_URL_REASON / JEB_DB_URL_INGEST
  // to least-privilege roles; each falls back to the shared DATABASE_URL.
  const roleDbUrl =
    role === "reason" || role === "nlq"
      ? process.env.JEB_DB_URL_REASON
      : role === "ingest" || role === "ingest-knowledge"
        ? process.env.JEB_DB_URL_INGEST
        : undefined;
  const cfg = parseSafe({
    nexusUrl: process.env.JEB_NEXUS_URL?.trim() || "https://nexus.staging.pubky.app",
    homeserverPk: process.env.JEB_HOMESERVER?.trim() || "",
    signupToken: process.env.JEB_SIGNUP_TOKEN?.trim() || undefined,
    secretKeyHex,
    databaseUrl: roleDbUrl?.trim() || process.env.DATABASE_URL?.trim(),
    cannedReply: canned !== undefined && canned !== "" ? canned : undefined,
    modelDelayMs: num("JEB_MODEL_DELAY_MS", 0),
    maxRepliesPerThread: num("JEB_MAX_REPLIES_PER_THREAD", 12),
    maxTurnsPerUserPerThread: num("JEB_MAX_TURNS_PER_USER_PER_THREAD", 6),
    maxPerUserPerHour: num("JEB_MAX_PER_USER_PER_HOUR", 5),
    maxAgeMinutes: num("JEB_MAX_AGE_MINUTES", 30),
    pollMs: num("JEB_POLL_MS", 3_000),
    model: process.env.JEB_MODEL?.trim() || "gpt-4o-mini",
    modelBaseUrl: optUrl("JEB_MODEL_BASE_URL"),
    modelApiKey: process.env.JEB_MODEL_API_KEY || undefined,
    modelTimeoutMs: num("JEB_MODEL_TIMEOUT_MS", 30_000),
    answerBudgetMs: num("JEB_ANSWER_BUDGET_MS", 180_000),
    replyDeadlineMs: num("JEB_REPLY_DEADLINE_MS", 240_000),
    modelTemperature: optNum("JEB_MODEL_TEMPERATURE"),
    dailyTokenBudget: num("JEB_DAILY_TOKEN_BUDGET", DEFAULT_DAILY_TOKEN_BUDGET),
    userDailyTokenBudget: num("JEB_USER_DAILY_TOKEN_BUDGET", DEFAULT_USER_DAILY_TOKEN_BUDGET),
    modelPricePerMtokIn: num("JEB_MODEL_PRICE_PER_MTOK_IN", DEFAULT_MODEL_PRICE_PER_MTOK_IN),
    modelPricePerMtokOut: num("JEB_MODEL_PRICE_PER_MTOK_OUT", DEFAULT_MODEL_PRICE_PER_MTOK_OUT),
    blocklist: new Set(
      (process.env.JEB_BLOCKLIST ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
    knownBots: new Set(
      (process.env.JEB_KNOWN_BOTS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
    disabledEnv: process.env.JEB_DISABLED === "1",
    port: portRaw ? Number(portRaw) : undefined,
    adminPort: adminPortRaw ? Number(adminPortRaw) : undefined,
    adminToken: process.env.ADMIN_TOKEN?.trim() || undefined,
    testnet: process.env.JEB_TESTNET === "1",
    maxPublishAttempts: num("JEB_MAX_PUBLISH_ATTEMPTS", 5),
    publishStaleMs: num("JEB_PUBLISH_STALE_MS", 120_000),
    workMaxAttempts: num("JEB_WORK_MAX_ATTEMPTS", 3),
    // Must exceed the overall answer budget and the reply deadline, otherwise a
    // legitimately in-flight claim is reaped underneath the reason worker.
    workStaleMs: num("JEB_WORK_STALE_MS", 270_000),
    toolMaxSteps: num("JEB_TOOL_MAX_STEPS", 4),
    role,
    botPk: process.env.JEB_BOT_PK?.trim() || undefined,
    bind: process.env.JEB_BIND?.trim() || "127.0.0.1",
    reasonConcurrency: num("JEB_REASON_CONCURRENCY", 2),
    nexusTimeoutMs: num("JEB_NEXUS_TIMEOUT_MS", 10_000),
    scoutUrl: process.env.JEB_SCOUT_URL?.trim() || "https://nexus-scout.pubky.app",
    scoutEnabled: process.env.JEB_SCOUT_ENABLED !== "0",
    scoutTimeoutMs: num("JEB_SCOUT_TIMEOUT_MS", 12_000),
    scoutLimitMax: Math.min(100, num("JEB_SCOUT_LIMIT_MAX", 50)),
    scoutRawEnabled: process.env.JEB_SCOUT_RAW_ENABLED === "1",
    scoutPerMentionCap: num("JEB_SCOUT_PER_MENTION_CAP", 12),
    scoutDailyCeiling: num("JEB_SCOUT_DAILY_CEILING", 400),
    scoutRawPerUserDaily: num("JEB_SCOUT_RAW_PER_USER_DAILY", 8),
    scoutRawGlobalDaily: num("JEB_SCOUT_RAW_GLOBAL_DAILY", 40),
    scoutProfilePropMax: num("JEB_SCOUT_PROFILE_PROP_MAX", 3),
    scoutClaimantCap: num("JEB_SCOUT_CLAIMANT_CAP", 12),
    scoutCanaryEnabled: process.env.JEB_SCOUT_CANARY_ENABLED !== "false",
    scoutCanaryIntervalMs: num("JEB_SCOUT_CANARY_INTERVAL_MS", 3_600_000),
    scoutCanaryUnknownThreshold: num("JEB_SCOUT_CANARY_UNKNOWN_THRESHOLD", 3),
    scoutMaxQps: num("JEB_SCOUT_MAX_QPS", 2),
    scoutSchemaRefreshMs: num("JEB_SCOUT_SCHEMA_REFRESH_MS", 21_600_000),
    appUrl: process.env.JEB_APP_URL?.trim().replace(/\/$/, "") || "https://pubky.app",
    webProvider: ((): "moonshot" | "brave" | "off" => {
      const raw = (process.env.JEB_WEB_PROVIDER ?? "moonshot").trim().toLowerCase();
      if (raw === "moonshot" || raw === "brave" || raw === "off") return raw;
      throw new Error("invalid JEB_WEB_PROVIDER");
    })(),
    braveApiKey: process.env.JEB_BRAVE_API_KEY?.trim() || undefined,
    webTimeoutMs: num("JEB_WEB_TIMEOUT_MS", 45_000),
    webPerMentionCap: num("JEB_WEB_PER_MENTION_CAP", 2),
    webDailyCeiling: num("JEB_WEB_DAILY_CEILING", 200),
    selfTags: process.env.JEB_SELF_TAGS !== "0",
    // Operator emergency valve: comma list of secret-scrubber rule ids to
    // skip (e.g. "bip39") so a future false positive can be switched off
    // without a rollback. Logged as a warn at startup (src/main.ts).
    // Unrecognized ids (operator typos) are warned about and dropped — a
    // typo must never look like it disabled something.
    scrubDisabledRules: (() => {
      const known = new Set<string>(SECRET_SCRUB_RULES);
      const out = new Set<string>();
      const unknown: string[] = [];
      for (const part of (process.env.JEB_SCRUB_DISABLED_RULES ?? "").split(",")) {
        const r = part.trim();
        if (!r) continue;
        if (known.has(r)) out.add(r);
        else unknown.push(r);
      }
      if (unknown.length > 0) {
        log.warn(
          { event: "config_warn", var: "JEB_SCRUB_DISABLED_RULES", unknown },
          "unrecognized secret-scrubber rule ids in JEB_SCRUB_DISABLED_RULES ignored",
        );
      }
      return out;
    })(),
  });
  warnLowProductionLimits(cfg);
  return cfg;
}
