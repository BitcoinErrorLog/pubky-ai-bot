import type { Config } from "../config.js";
import { Store } from "../db.js";
import { DRAFT_FORMATS, DRAFT_STATUSES, FORMAT_ENV, parseDraftFormat, type DraftFormat, type DraftStatus } from "./types.js";
import { draftFormatEnabled, draftsGloballyEnabled, generateFormat } from "./generate.js";
import { DraftRejectedError } from "./finish.js";
import { assertNoAutonomousDraftPublish } from "./no-autonomous.js";
import { approveDraftToPublishRequest } from "./publish-request.js";
import { collectDraftStats, formatStatsLines } from "./stats.js";
import { writeDraftMarkdownFiles } from "./render-md.js";

function argValue(flag: string, argv: string[]): string | undefined {
  const i = argv.indexOf(flag);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("-")) return argv[i + 1];
  return undefined;
}

function subcommand(argv: string[]): { cmd: string; rest: string[] } {
  const roleI = argv.indexOf("--role");
  const start = roleI >= 0 ? roleI + 2 : 2;
  const slice = argv.slice(start).filter((a) => a !== "--role" && a !== "drafts");
  const cmd = slice[0] ?? "";
  return { cmd, rest: slice.slice(1) };
}

function formatsToRun(raw: string | undefined): DraftFormat[] {
  if (!raw || raw === "all") return [...DRAFT_FORMATS];
  return [parseDraftFormat(raw)];
}

export async function runDraftsRole(cfg: Config, argv = process.argv): Promise<{ ok: boolean; lines: string[] }> {
  assertNoAutonomousDraftPublish();
  const { cmd, rest } = subcommand(argv);
  const store = new Store(cfg.databaseUrl);
  await store.migrate();
  const lines: string[] = [];
  try {
    if (cmd === "generate") {
      if (!draftsGloballyEnabled()) {
        return { ok: false, lines: ["drafts disabled: set JEB_DRAFTS_ENABLED=1"] };
      }
      const selected = formatsToRun(argValue("--format", rest) ?? argValue("--format", argv));
      let ok = true;
      for (const format of selected) {
        if (!draftFormatEnabled(format)) {
          lines.push(`${format}\tskipped\tswitch off (${FORMAT_ENV[format]})`);
          continue;
        }
        try {
          const draft = await generateFormat({ format, cfg, store });
          const id = await store.insertDraft(draft);
          lines.push(`${format}\tgenerated\tid=${id}\turis=${draft.evidence.uris.length}`);
        } catch (e) {
          const msg = e instanceof DraftRejectedError ? e.message : e instanceof Error ? e.message : String(e);
          if (e instanceof DraftRejectedError && /: none:/.test(e.message)) {
            lines.push(`${format}\tnone\t${msg}`);
          } else {
            ok = false;
            lines.push(`${format}\trejected\t${msg}`);
          }
        }
      }
      return { ok, lines };
    }
    if (cmd === "list") {
      const statusRaw = argValue("--status", rest) ?? argValue("--status", argv);
      const status = statusRaw as DraftStatus | undefined;
      if (status && !(DRAFT_STATUSES as readonly string[]).includes(status)) {
        return { ok: false, lines: ["--status must be draft|approved|rejected|published|declined"] };
      }
      const rows = await store.listDrafts(status);
      for (const r of rows) {
        lines.push(`${r.id}\t${r.format}\t${r.status}\t${r.decided_by ?? ""}\t${r.title ?? ""}`);
      }
      lines.push(`count=${rows.length}`);
      return { ok: true, lines };
    }
    if (cmd === "show") {
      const id = Number(rest[0] ?? argv[argv.indexOf("show") + 1]);
      if (!Number.isInteger(id) || id < 1) return { ok: false, lines: ["show requires a draft id"] };
      const row = await store.getDraft(id);
      if (!row) return { ok: false, lines: [`draft ${id} not found`] };
      lines.push(JSON.stringify(row, null, 2));
      return { ok: true, lines };
    }
    if (cmd === "approve") {
      const id = Number(rest[0] ?? argv[argv.indexOf("approve") + 1]);
      const by = argValue("--by", rest) ?? argValue("--by", argv);
      if (!Number.isInteger(id) || id < 1) return { ok: false, lines: ["approve requires a draft id"] };
      if (!by) return { ok: false, lines: ["approve requires --by <handle>"] };
      const result = await approveDraftToPublishRequest(store, { draftId: id, decidedBy: by });
      lines.push(
        `approved id=${result.draft.id} publish_request_id=${result.publishRequestId} day=${result.draft.proactive_utc_day ?? ""}`,
      );
      return { ok: true, lines };
    }
    if (cmd === "reject") {
      const id = Number(rest[0] ?? argv[argv.indexOf("reject") + 1]);
      const by = argValue("--by", rest) ?? argValue("--by", argv);
      const reason = argValue("--reason", rest) ?? argValue("--reason", argv);
      if (!Number.isInteger(id) || id < 1) return { ok: false, lines: ["reject requires a draft id"] };
      if (!by) return { ok: false, lines: ["reject requires --by <handle>"] };
      if (!reason) return { ok: false, lines: ["reject requires --reason <text>"] };
      const row = await store.rejectDraft(id, by, reason);
      lines.push(`rejected id=${row.id} by=${row.decided_by}`);
      return { ok: true, lines };
    }
    if (cmd === "stats") {
      const rows = await collectDraftStats(store, { nexusUrl: cfg.nexusUrl, timeoutMs: cfg.nexusTimeoutMs });
      lines.push(...formatStatsLines(rows));
      return { ok: true, lines };
    }
    if (cmd === "render") {
      const outDir = argValue("--out", rest) ?? argValue("--out", argv);
      if (!outDir) return { ok: false, lines: ["render requires --out <dir>"] };
      const idRaw = argValue("--id", rest) ?? argValue("--id", argv);
      const all = rest.includes("--all") || argv.includes("--all") || !idRaw;
      let rows = await store.listDrafts("draft");
      if (idRaw) {
        const id = Number(idRaw);
        if (!Number.isInteger(id) || id < 1) return { ok: false, lines: ["--id must be a draft id"] };
        const one = await store.getDraft(id);
        if (!one) return { ok: false, lines: [`draft ${id} not found`] };
        rows = [one];
      } else if (!all) {
        return { ok: false, lines: ["render requires --all or --id <id>"] };
      }
      const written = writeDraftMarkdownFiles(rows, outDir);
      for (const p of written) lines.push(p);
      lines.push(`count=${written.length}`);
      return { ok: true, lines };
    }
    if (cmd === "regenerate") {
      const id = Number(rest[0] ?? argv[argv.indexOf("regenerate") + 1]);
      if (!Number.isInteger(id) || id < 1) return { ok: false, lines: ["regenerate requires a draft id"] };
      const existing = await store.getDraft(id);
      if (!existing || existing.status !== "draft") {
        return { ok: false, lines: [`draft ${id} not found or not in draft status`] };
      }
      if (!draftsGloballyEnabled()) {
        return { ok: false, lines: ["drafts disabled: set JEB_DRAFTS_ENABLED=1"] };
      }
      if (!draftFormatEnabled(existing.format)) {
        return { ok: false, lines: [`${existing.format} skipped: switch off (${FORMAT_ENV[existing.format]})`] };
      }
      try {
        const draft = await generateFormat({ format: existing.format, cfg, store });
        const row = await store.updateDraftContent(id, draft);
        lines.push(`regenerated\tid=${row.id}\tformat=${row.format}`);
        return { ok: true, lines };
      } catch (e) {
        const msg = e instanceof DraftRejectedError ? e.message : e instanceof Error ? e.message : String(e);
        return { ok: false, lines: [`${existing.format}\trejected\t${msg}`] };
      }
    }
    return {
      ok: false,
      lines: ["usage: --role drafts generate|list|show|approve|reject|stats|render|regenerate"],
    };
  } finally {
    await store.close();
  }
}
