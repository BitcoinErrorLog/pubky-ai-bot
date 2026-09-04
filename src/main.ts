import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { configFromProcessEnv, parseRole, type Config } from "./config.js";
import { Store } from "./db.js";
import { runIngest } from "./ingest.js";
import { runPublish } from "./publish.js";
import { runReason } from "./reason.js";
import { publicBotPk } from "./homeserver.js";
import { ingestChildEnv, reasonChildEnv } from "./keys.js";
import { log } from "./log.js";
import { runKnowledgeIngest } from "./knowledge/run-ingest.js";
import { mentionUrisFromArgv, replaceFlagFromArgv, replyUriFromArgv, runRequeue } from "./requeue.js";
import { SHUTDOWN_GRACE_MS } from "./shutdown.js";
import { runCollectionsCli } from "./collections.js";
import { runTagsCli } from "./tags.js";

async function runAll(cfg: Config): Promise<() => Promise<void>> {
  const botPk = cfg.botPk || publicBotPk(cfg.secretKeyHex);
  const parentStore = new Store(cfg.databaseUrl);
  await parentStore.migrate();
  try {
    const chunks = await parentStore.knowledgeChunkCount();
    if (chunks === 0) {
      log.info("knowledge corpus empty; run --role ingest-knowledge");
    }
  } finally {
    await parentStore.close();
  }
  const self = fileURLToPath(import.meta.url);
  const children: ChildProcess[] = [];
  const spawnRole = (role: "ingest" | "reason" | "publish", env: NodeJS.ProcessEnv) => {
    const child = spawn(process.execPath, [self, "--role", role], {
      env: { ...env, JEB_BOT_PK: botPk, JEB_SKIP_MIGRATIONS: "1" },
      stdio: "inherit",
    });
    child.on("exit", (code) => {
      if (code && code !== 0) log.info({ role, code }, "child exited");
    });
    children.push(child);
  };
  // Minimal env per role: ingest/reason get explicit allowlists (no key
  // material, no signup token, no admin token/port). Publish keeps the full
  // env — it alone holds the signing key and serves the admin listener.
  spawnRole("ingest", ingestChildEnv(process.env));
  spawnRole("reason", reasonChildEnv(process.env));
  spawnRole("publish", { ...process.env });
  return async () => {
    for (const c of children) c.kill("SIGTERM");
    await Promise.all(
      children.map(
        (c) =>
          new Promise<void>((resolve) => {
            if (c.exitCode !== null) {
              resolve();
              return;
            }
            const t = setTimeout(resolve, SHUTDOWN_GRACE_MS);
            c.once("exit", () => {
              clearTimeout(t);
              resolve();
            });
          }),
      ),
    );
    for (const c of children) {
      if (c.exitCode === null) c.kill("SIGKILL");
    }
  };
}

function argFlag(flag: string, argv = process.argv): boolean {
  return argv.includes(flag);
}

function argValue(flag: string, argv = process.argv): string | undefined {
  const i = argv.indexOf(flag);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("-")) return argv[i + 1];
  return undefined;
}

const role = parseRole();
const requireSecret = role === "all" || role === "publish" || role === "tags";
const cfg = configFromProcessEnv({ requireSecret, role });

if (cfg.scrubDisabledRules.size > 0) {
  log.warn(
    { event: "security_event", rules: [...cfg.scrubDisabledRules] },
    "secret-scrubber rules disabled via JEB_SCRUB_DISABLED_RULES (emergency valve)",
  );
}

if (role === "ingest-knowledge") {
  const result = await runKnowledgeIngest({
    databaseUrl: cfg.databaseUrl,
    full: argFlag("--full"),
    sourceFilter: argValue("--source"),
  });
  if (!result.ok) {
    log.info({ err: result.error }, "ingest-knowledge failed");
    console.error(result.error);
    process.exit(1);
  }
  console.log(JSON.stringify(result.report, null, 2));
  log.info({ chunks: result.report.db.chunks, wall_ms: result.report.wall_ms }, "ingest-knowledge done");
  process.exit(0);
}

if (role === "requeue") {
  const uris = mentionUrisFromArgv(process.argv);
  if (uris.length === 0) {
    console.error("requeue requires --mention <post URI>");
    process.exit(1);
  }
  let replyUri: string | undefined;
  try {
    replyUri = replyUriFromArgv(process.argv);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
  const result = await runRequeue(cfg, uris, {
    replace: replaceFlagFromArgv(process.argv),
    replyUri,
  });
  for (const line of result.lines) console.log(line);
  process.exit(result.ok ? 0 : 1);
}

if (role === "drafts") {
  const { runDraftsRole } = await import("./drafts/cli.js");
  const result = await runDraftsRole(cfg);
  for (const line of result.lines) console.log(line);
  process.exit(result.ok ? 0 : 1);
}

if (role === "optouts") {
  const store = new Store(cfg.databaseUrl);
  await store.migrate();
  try {
    const rows = await store.listUserOptouts();
    for (const row of rows) {
      const at = row.opted_out_at instanceof Date ? row.opted_out_at.toISOString() : String(row.opted_out_at);
      console.log(`${row.pubky}\t${at}\t${row.reason ?? ""}`);
    }
    console.log(`count=${rows.length}`);
  } finally {
    await store.close();
  }
  process.exit(0);
}

if (role === "tags") {
  const result = await runTagsCli(cfg);
  for (const line of result.lines) console.log(line);
  process.exit(result.ok ? 0 : 1);
}

if (role === "collections") {
  const result = await runCollectionsCli(cfg);
  for (const line of result.lines) console.log(line);
  process.exit(result.ok ? 0 : 1);
}

let stop: () => Promise<void>;
if (role === "all") stop = await runAll(cfg);
else if (role === "ingest") stop = await runIngest(cfg);
else if (role === "reason") stop = await runReason(cfg);
else stop = await runPublish(cfg);

process.on("SIGINT", () => void stop().then(() => process.exit(0)));
process.on("SIGTERM", () => void stop().then(() => process.exit(0)));
log.info({ role, bot: cfg.botPk }, "started");
