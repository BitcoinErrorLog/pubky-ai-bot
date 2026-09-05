import { isValidTagLabel } from "../reply-tags.js";
import type { Config } from "../config.js";
import { Store } from "../db.js";
import { Z32 } from "../types.js";
import { projectSlug } from "./learn.js";
import {
  getTrackedProject,
  insertTrackedProject,
  listTrackedProjects,
  promoteTrackedProject,
  removeTrackedProject,
} from "./store.js";
import type { TrackedProject } from "./types.js";

function argValue(flag: string, argv: string[]): string | undefined {
  const i = argv.indexOf(flag);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("-")) return argv[i + 1];
  return undefined;
}

function csv(flag: string, argv: string[]): string[] {
  const raw = argValue(flag, argv);
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function argvAfterRole(argv: string[]): string[] {
  const roleIdx = argv.indexOf("--role");
  return roleIdx >= 0 ? argv.slice(roleIdx + 2) : argv.slice(2);
}

function parsePubkys(raw: string[]): string[] {
  const out: string[] = [];
  for (const id of raw) {
    if (!Z32.test(id)) throw new Error(`invalid pubky id: ${id}`);
    out.push(id);
  }
  return out;
}

export async function runProjectsCli(cfg: Config, argv = process.argv): Promise<{ ok: boolean; lines: string[] }> {
  const after = argvAfterRole(argv);
  const cmd = after[0] ?? "";
  const store = new Store(cfg.databaseUrl);
  await store.migrate();
  try {
    if (cmd === "list") {
      const rows = await listTrackedProjects(store.pool);
      const lines = rows.map(
        (p) => `${p.id}\t${p.status}\t${p.name}\ttags=${p.tags.join(",")}\taliases=${p.aliases.join(",")}`,
      );
      lines.push(`count=${rows.length}`);
      return { ok: true, lines };
    }
    if (cmd === "promote") {
      const id = after[1];
      if (!id) return { ok: false, lines: ["usage: --role projects promote <id>"] };
      const ok = await promoteTrackedProject(store.pool, id);
      return { ok, lines: [ok ? `promoted ${id}` : `not a candidate: ${id}`] };
    }
    if (cmd === "remove") {
      const id = after[1];
      if (!id) return { ok: false, lines: ["usage: --role projects remove <id>"] };
      const ok = await removeTrackedProject(store.pool, id);
      return { ok, lines: [ok ? `removed ${id}` : `not found: ${id}`] };
    }
    if (cmd === "add") {
      const name = argValue("--name", after) ?? argValue("--name", argv);
      if (!name) return { ok: false, lines: ["usage: --role projects add --name <name> [--aliases a,b] [--tags t] [--pubky pk]"] };
      let pubkys: string[];
      try {
        pubkys = parsePubkys(csv("--pubky", [...after, ...argv]));
      } catch (e) {
        return { ok: false, lines: [e instanceof Error ? e.message : String(e)] };
      }
      const tags = csv("--tags", [...after, ...argv])
        .map((t) => t.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 20))
        .filter((t) => isValidTagLabel(t));
      const project: TrackedProject = {
        id: argValue("--id", after) ?? argValue("--id", argv) ?? projectSlug(name),
        name,
        aliases: csv("--aliases", [...after, ...argv]),
        tags,
        pubky_ids: pubkys,
        status: "active",
      };
      const existing = await getTrackedProject(store.pool, project.id);
      if (existing) return { ok: false, lines: [`already exists: ${project.id}`] };
      await insertTrackedProject(store.pool, project);
      return { ok: true, lines: [`added ${project.id}`] };
    }
    return { ok: false, lines: ["usage: --role projects list|promote|add|remove"] };
  } finally {
    await store.close();
  }
}
