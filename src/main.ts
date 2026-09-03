import { configFromProcessEnv } from "./config.js";
import { Bot } from "./bot.js";
import { log } from "./log.js";

const cfg = configFromProcessEnv({ requireSecret: true });
const bot = new Bot(cfg);
process.on("SIGINT", () => void bot.stop().then(() => process.exit(0)));
process.on("SIGTERM", () => void bot.stop().then(() => process.exit(0)));
await bot.start();
log.info({ bot: bot.botPk }, "started");
