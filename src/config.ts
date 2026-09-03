import { z } from "zod";
import { secretFromEnv } from "./keys.js";

const schema = z.object({
  nexusUrl: z.string().url(),
  homeserverPk: z.string(),
  signupToken: z.string().optional(),
  secretKeyHex: z.string().regex(/^[0-9a-f]{64}$/),
  databaseUrl: z.string().min(1),
  cannedReply: z.string().optional(),
  modelDelayMs: z.number().nonnegative(),
  maxRepliesPerThread: z.number().int().positive(),
  maxPerUserPerHour: z.number().int().positive(),
  maxAgeMinutes: z.number().nonnegative(),
  pollMs: z.number().positive(),
  model: z.string().min(1),
  modelBaseUrl: z.string().url().optional(),
  modelApiKey: z.string().optional(),
  modelTimeoutMs: z.number().positive(),
  dailyTokenBudget: z.number().int().positive(),
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
  role: z.enum(["all", "ingest", "reason", "publish"]),
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
});

export type Config = z.infer<typeof schema>;

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
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
    if (r === "all" || r === "ingest" || r === "reason" || r === "publish") return r;
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

export function configFromProcessEnv(opts?: { requireSecret: boolean; role?: Config["role"] }): Config {
  const requireSecret = opts?.requireSecret ?? true;
  const secretKeyHex = requireSecret ? secretFromEnv() : "00".repeat(32);
  const portRaw = process.env.JEB_PORT ?? process.env.JEB_HEALTH_PORT;
  const adminPortRaw = process.env.JEB_ADMIN_PORT;
  const canned = process.env.JEB_CANNED_REPLY;
  return parseSafe({
    nexusUrl: process.env.JEB_NEXUS_URL?.trim() || "https://nexus.staging.pubky.app",
    homeserverPk: process.env.JEB_HOMESERVER?.trim() || "",
    signupToken: process.env.JEB_SIGNUP_TOKEN?.trim() || undefined,
    secretKeyHex,
    databaseUrl: process.env.DATABASE_URL?.trim(),
    cannedReply: canned !== undefined && canned !== "" ? canned : undefined,
    modelDelayMs: num("JEB_MODEL_DELAY_MS", 0),
    maxRepliesPerThread: num("JEB_MAX_REPLIES_PER_THREAD", 1),
    maxPerUserPerHour: num("JEB_MAX_PER_USER_PER_HOUR", 5),
    maxAgeMinutes: num("JEB_MAX_AGE_MINUTES", 30),
    pollMs: num("JEB_POLL_MS", 10_000),
    model: process.env.JEB_MODEL?.trim() || "gpt-4o-mini",
    modelBaseUrl: optUrl("JEB_MODEL_BASE_URL"),
    modelApiKey: process.env.JEB_MODEL_API_KEY || undefined,
    modelTimeoutMs: num("JEB_MODEL_TIMEOUT_MS", 30_000),
    dailyTokenBudget: num("JEB_DAILY_TOKEN_BUDGET", 2_000_000),
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
    // Must exceed the model timeout + tool-loop worst case, otherwise a
    // legitimately in-flight claim is reaped underneath the reason worker.
    workStaleMs: num("JEB_WORK_STALE_MS", 180_000),
    toolMaxSteps: num("JEB_TOOL_MAX_STEPS", 6),
    role: opts?.role ?? parseRole(),
    botPk: process.env.JEB_BOT_PK?.trim() || undefined,
    bind: process.env.JEB_BIND?.trim() || "127.0.0.1",
    reasonConcurrency: num("JEB_REASON_CONCURRENCY", 2),
    nexusTimeoutMs: num("JEB_NEXUS_TIMEOUT_MS", 10_000),
    scoutUrl: process.env.JEB_SCOUT_URL?.trim() || "https://nexus-scout.pubky.app",
    scoutEnabled: process.env.JEB_SCOUT_ENABLED !== "0",
    scoutTimeoutMs: num("JEB_SCOUT_TIMEOUT_MS", 12_000),
    scoutLimitMax: Math.min(100, num("JEB_SCOUT_LIMIT_MAX", 50)),
    scoutRawEnabled: process.env.JEB_SCOUT_RAW_ENABLED === "1",
    scoutPerMentionCap: num("JEB_SCOUT_PER_MENTION_CAP", 6),
    scoutDailyCeiling: num("JEB_SCOUT_DAILY_CEILING", 400),
    scoutRawPerUserDaily: num("JEB_SCOUT_RAW_PER_USER_DAILY", 8),
    scoutRawGlobalDaily: num("JEB_SCOUT_RAW_GLOBAL_DAILY", 40),
    scoutProfilePropMax: num("JEB_SCOUT_PROFILE_PROP_MAX", 3),
    scoutClaimantCap: num("JEB_SCOUT_CLAIMANT_CAP", 12),
  });
}
