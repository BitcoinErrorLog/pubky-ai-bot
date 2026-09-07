import type { Config } from "../config.js";
import { Store } from "../db.js";
import { recoverLegacyWeeklyPost } from "./store.js";
import { parseWeekKey, parseWeeklySeries } from "./types.js";

function value(flag: string, argv: string[]): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function runLegacyRecoveryCli(
  cfg: Config,
  argv = process.argv,
): Promise<{ ok: boolean; lines: string[] }> {
  const seriesRaw = value("--series", argv);
  const weekRaw = value("--week", argv);
  const dryRun = argv.includes("--dry-run");
  const apply = argv.includes("--apply");
  if (!seriesRaw || !weekRaw || dryRun === apply) {
    return { ok: false, lines: ["usage: --recover-legacy-post-ids --series <feedback|updates> --week 2026-W36 --dry-run|--apply"] };
  }
  let series;
  let weekKey;
  try {
    series = parseWeeklySeries(seriesRaw);
    weekKey = parseWeekKey(weekRaw);
  } catch (e) {
    return { ok: false, lines: [e instanceof Error ? e.message : String(e)] };
  }
  if (weekKey !== "2026-W36") return { ok: false, lines: ["legacy recovery only supports 2026-W36"] };
  if (!cfg.botPk) return { ok: false, lines: ["legacy recovery requires JEB_BOT_PK"] };
  const store = new Store(cfg.databaseUrl);
  if (apply) await store.migrate();
  try {
    const result = await recoverLegacyWeeklyPost(store.pool, {
      series,
      weekKey,
      botPk: cfg.botPk,
      dryRun,
    });
    return {
      ok: true,
      lines: [
        `${result.status} series=${series} week=${weekKey}`,
        `old_uri=${result.oldUri}`,
        `replacement_uri=${result.replacementUri}`,
      ],
    };
  } catch (e) {
    return { ok: false, lines: [e instanceof Error ? e.message : String(e)] };
  } finally {
    await store.close();
  }
}
