import type { Config } from "../config.js";
import { Store } from "../db.js";
import { Nexus } from "../nexus.js";
import { envSwitchOn } from "../switches.js";
import { formatClassifierCounts } from "./classify-mentions.js";
import { runWeeklySeries } from "./run.js";
import { parseWeekKey, parseWeeklySeries } from "./types.js";
import { nextIssueWeekKey } from "./week-key.js";

function argValue(flag: string, argv: string[]): string | undefined {
  const i = argv.indexOf(flag);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("-")) return argv[i + 1];
  return undefined;
}

function argvAfterRole(argv: string[]): string[] {
  const roleIdx = argv.indexOf("--role");
  return roleIdx >= 0 ? argv.slice(roleIdx + 2) : argv.slice(2);
}

export async function runWeeklyCli(cfg: Config, argv = process.argv): Promise<{ ok: boolean; lines: string[] }> {
  const after = argvAfterRole(argv);
  const cmd = after[0];
  if (cmd !== "run") {
    return { ok: false, lines: ["usage: --role weekly run feedback|updates [--week YYYY-Www] [--dry-run]"] };
  }
  const seriesRaw = after[1];
  let series;
  try {
    series = parseWeeklySeries(seriesRaw ?? "");
  } catch (e) {
    return { ok: false, lines: [e instanceof Error ? e.message : String(e)] };
  }
  const dryRun = argv.includes("--dry-run") || after.includes("--dry-run");
  let weekKey: string | undefined;
  const weekRaw = argValue("--week", after) ?? argValue("--week", argv);
  try {
    if (weekRaw) weekKey = parseWeekKey(weekRaw);
  } catch (e) {
    return { ok: false, lines: [e instanceof Error ? e.message : String(e)] };
  }
  if (!weekKey) {
    weekKey = nextIssueWeekKey(series, new Date(), cfg.weeklyTz);
  }
  if (!cfg.weeklyEnabled) return { ok: false, lines: ["weekly disabled: set JEB_WEEKLY_ENABLED=1"] };
  if (!dryRun && (envSwitchOn("weekly") || envSwitchOn("global"))) {
    return { ok: false, lines: ["weekly switch on"] };
  }
  const store = new Store(cfg.databaseUrl);
  if (!dryRun) await store.migrate();
  if (!dryRun && (await store.switchOn("weekly"))) {
    await store.close();
    return { ok: false, lines: ["weekly switch on"] };
  }
  const nexus = new Nexus(cfg.nexusUrl, cfg.nexusTimeoutMs);
  try {
    const result = await runWeeklySeries({ cfg, store, nexus, series, weekKey, dryRun });
    const lines = result.markdown ? [result.markdown] : ["(empty — nothing to publish)"];
    if (result.skipped) lines.push("skipped=true");
    if (result.published) lines.push("published=queued");
    lines.push(
      `window week=${result.weekKey} since=${new Date(result.window.sinceMs).toISOString()} until=${new Date(result.window.untilMs).toISOString()}`,
    );
    if (result.classifierCounts) lines.push(formatClassifierCounts(result.classifierCounts));
    return { ok: true, lines };
  } finally {
    await store.close();
  }
}
