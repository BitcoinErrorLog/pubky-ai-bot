import type { CandidatePost } from "./gather.js";
import type { WeeklyQueryable } from "./store.js";
import { insertTrackedProject } from "./store.js";
import type { TrackedProject } from "./types.js";

const ECOSYSTEM = /\b(pubky|homeserver|pkarr|pkdns)\b/i;
const NAME = /\b([A-Z][A-Za-z0-9]+(?:[ -][A-Z][A-Za-z0-9]+){0,2})\b/g;

const STOP = new Set([
  "The",
  "This",
  "That",
  "There",
  "These",
  "Those",
  "When",
  "What",
  "With",
  "From",
  "Your",
  "Have",
  "Will",
  "Just",
  "Also",
  "Into",
  "Over",
  "After",
  "Before",
  "Monday",
  "Sunday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "January",
  "February",
  "March",
  "April",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
  "Pubky",
  "Jeb",
]);

export function projectSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  if (!slug) throw new Error("project name produced an empty id");
  return slug;
}

export function knownNeedles(projects: TrackedProject[]): Set<string> {
  const out = new Set<string>();
  for (const p of projects) {
    out.add(p.id.toLowerCase());
    out.add(p.name.toLowerCase());
    for (const a of p.aliases) out.add(a.toLowerCase());
    for (const t of p.tags) out.add(t.toLowerCase());
  }
  return out;
}

export function detectCandidateNames(
  posts: CandidatePost[],
  projects: TrackedProject[],
): Array<{ name: string; count: number; authors: number }> {
  const known = knownNeedles(projects);
  const counts = new Map<string, { name: string; authors: Set<string> }>();
  for (const post of posts) {
    if (!ECOSYSTEM.test(post.content)) continue;
    NAME.lastIndex = 0;
    let m: RegExpExecArray | null;
    const seenInPost = new Set<string>();
    while ((m = NAME.exec(post.content))) {
      const name = m[1] ?? "";
      if (name.length < 3 || STOP.has(name.split(/[ -]/)[0] ?? "")) continue;
      if (known.has(name.toLowerCase()) || known.has(name.replace(/\s+/g, "-").toLowerCase())) continue;
      if (seenInPost.has(name.toLowerCase())) continue;
      seenInPost.add(name.toLowerCase());
      const cur = counts.get(name.toLowerCase()) ?? { name, authors: new Set<string>() };
      cur.authors.add(post.author);
      counts.set(name.toLowerCase(), cur);
    }
  }
  const out: Array<{ name: string; count: number; authors: number }> = [];
  for (const { name, authors } of counts.values()) {
    const count = [...posts].filter((p) => ECOSYSTEM.test(p.content) && p.content.includes(name)).length;
    if (count >= 3 && authors.size >= 2) out.push({ name, count, authors: authors.size });
  }
  return out.sort((a, b) => b.count - a.count);
}

export async function learnCandidateProjects(
  db: WeeklyQueryable,
  posts: CandidatePost[],
  projects: TrackedProject[],
  opts?: { persist?: boolean },
): Promise<TrackedProject[]> {
  const persist = opts?.persist !== false;
  const found = detectCandidateNames(posts, projects);
  const inserted: TrackedProject[] = [];
  for (const hit of found) {
    const project: TrackedProject = {
      id: projectSlug(hit.name),
      name: hit.name,
      aliases: [],
      tags: [projectSlug(hit.name).slice(0, 20)],
      pubky_ids: [],
      status: "candidate",
    };
    if (!persist) {
      inserted.push(project);
      continue;
    }
    if (await insertTrackedProject(db, project)) inserted.push(project);
  }
  return inserted;
}
