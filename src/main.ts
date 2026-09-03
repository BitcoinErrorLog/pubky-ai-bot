import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { configFromProcessEnv, parseRole, type Config } from "./config.js";
import { Store } from "./db.js";
import { runIngest } from "./ingest.js";
import { runPublish } from "./publish.js";
import { runReason } from "./reason.js";
import { publicBotPk } from "./homeserver.js";
import { stripKeyMaterialEnv } from "./keys.js";
import { log } from "./log.js";

async function runAll(cfg: Config): Promise<() => Promise<void>> {
  const botPk = cfg.botPk || publicBotPk(cfg.secretKeyHex);
  const parentStore = new Store(cfg.databaseUrl);
  await parentStore.migrate();
  await parentStore.close();
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
  spawnRole("ingest", stripKeyMaterialEnv(process.env));
  spawnRole("reason", stripKeyMaterialEnv(process.env));
  spawnRole("publish", { ...process.env });
  return async () => {
    for (const c of children) c.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 200));
    for (const c of children) {
      if (!c.killed) c.kill("SIGKILL");
    }
  };
}

const role = parseRole();
const requireSecret = role === "all" || role === "publish";
const cfg = configFromProcessEnv({ requireSecret, role });

let stop: () => Promise<void>;
if (role === "all") stop = await runAll(cfg);
else if (role === "ingest") stop = await runIngest(cfg);
else if (role === "reason") stop = await runReason(cfg);
else stop = await runPublish(cfg);

process.on("SIGINT", () => void stop().then(() => process.exit(0)));
process.on("SIGTERM", () => void stop().then(() => process.exit(0)));
log.info({ role, bot: cfg.botPk }, "started");
