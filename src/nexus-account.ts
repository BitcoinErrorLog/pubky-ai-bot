import type { Nexus } from "./nexus.js";

export interface JebAccountSnapshot {
  follows: number | null;
  following: number | null;
  muted: number | null;
  tags: Array<{ label: string; count: number }>;
  source: "nexus";
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function parseCounts(user: unknown): { follows: number | null; following: number | null; muted: number | null } {
  const root = asRecord(user);
  const counts = asRecord(root?.counts) ?? asRecord(root?.Counts);
  const follows = num(counts?.followers) ?? num(root?.followers);
  const following = num(counts?.following) ?? num(root?.following);
  const muted = num(counts?.muted) ?? num(counts?.blocked) ?? num(root?.muted);
  return { follows, following, muted };
}

function parseTags(tags: unknown): Array<{ label: string; count: number }> {
  if (!Array.isArray(tags)) return [];
  const out: Array<{ label: string; count: number }> = [];
  for (const item of tags) {
    const r = asRecord(item);
    if (!r) continue;
    const label = typeof r.label === "string" ? r.label : typeof r.tag === "string" ? r.tag : "";
    if (!label) continue;
    const count = num(r.taggers_count) ?? num(r.count) ?? num(r.taggersCount) ?? 0;
    out.push({ label, count: count ?? 0 });
  }
  return out;
}

export async function fetchJebAccountSnapshot(nexus: Nexus, botPk: string): Promise<JebAccountSnapshot> {
  const [user, tags] = await Promise.all([nexus.user(botPk), nexus.userTags(botPk)]);
  const counts = parseCounts(user);
  return {
    follows: counts.follows,
    following: counts.following,
    muted: counts.muted,
    tags: parseTags(tags),
    source: "nexus",
  };
}
