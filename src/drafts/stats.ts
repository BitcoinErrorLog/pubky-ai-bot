import { fetchJson } from "../http.js";
import { parsePostUri } from "../types.js";
import type { Store } from "../db.js";
import { DRAFT_FORMATS, type DraftFormat } from "./types.js";

export interface FormatStats {
  format: DraftFormat;
  generated: number;
  approved: number;
  rejected: number;
  published: number;
  reception: { replies: number; reposts: number; bookmarks: number; tags: number };
}

function asCount(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (Array.isArray(v)) return v.length;
  return 0;
}

export async function receptionFromNexusPost(
  nexusUrl: string,
  postUri: string,
  timeoutMs: number,
): Promise<{ replies: number; reposts: number; bookmarks: number; tags: number }> {
  let parsed;
  try {
    parsed = parsePostUri(postUri);
  } catch {
    return { replies: 0, reposts: 0, bookmarks: 0, tags: 0 };
  }
  const url = new URL(`/v0/post/${parsed.author}/${parsed.postId}`, nexusUrl);
  const { status, body } = await fetchJson(url, timeoutMs);
  if (status !== 200 || !body || typeof body !== "object") {
    return { replies: 0, reposts: 0, bookmarks: 0, tags: 0 };
  }
  const o = body as Record<string, unknown>;
  const counts = o.counts && typeof o.counts === "object" ? (o.counts as Record<string, unknown>) : {};
  const tags = Array.isArray(o.tags) ? o.tags : [];
  const tagCount = tags.reduce((n, t) => {
    if (t && typeof t === "object" && typeof (t as { taggers_count?: unknown }).taggers_count === "number") {
      return n + (t as { taggers_count: number }).taggers_count;
    }
    return n + 1;
  }, 0);
  return {
    replies: asCount(counts.replies ?? o.replies),
    reposts: asCount(counts.reposts ?? o.reposts),
    bookmarks: asCount(counts.bookmarks ?? o.bookmarks),
    tags: tagCount,
  };
}

export async function collectDraftStats(
  store: Store,
  opts: { nexusUrl: string; timeoutMs: number },
): Promise<FormatStats[]> {
  const counts = await store.draftCountsByFormat();
  const byFormat = new Map(counts.map((c) => [c.format, c]));
  const published = (await store.listDrafts("published")).filter((d) => d.publish_request_id);
  const pubRows = await store.pool.query<{ id: string; mention_key: string; format: string }>(
    `SELECT p.id::text, p.mention_key, d.format
     FROM drafts d
     JOIN publish_requests p ON p.id = d.publish_request_id
     WHERE d.status = 'published'`,
  );
  const reception = new Map<string, { replies: number; reposts: number; bookmarks: number; tags: number }>();
  for (const f of DRAFT_FORMATS) {
    reception.set(f, { replies: 0, reposts: 0, bookmarks: 0, tags: 0 });
  }
  for (const row of pubRows.rows) {
    const rec = await receptionFromNexusPost(opts.nexusUrl, row.mention_key, opts.timeoutMs);
    const cur = reception.get(row.format as DraftFormat) ?? { replies: 0, reposts: 0, bookmarks: 0, tags: 0 };
    reception.set(row.format as DraftFormat, {
      replies: cur.replies + rec.replies,
      reposts: cur.reposts + rec.reposts,
      bookmarks: cur.bookmarks + rec.bookmarks,
      tags: cur.tags + rec.tags,
    });
  }
  void published;
  return DRAFT_FORMATS.map((format) => {
    const c = byFormat.get(format) ?? { generated: 0, approved: 0, rejected: 0, published: 0 };
    return {
      format,
      generated: c.generated,
      approved: c.approved,
      rejected: c.rejected,
      published: c.published,
      reception: reception.get(format) ?? { replies: 0, reposts: 0, bookmarks: 0, tags: 0 },
    };
  });
}

export function formatStatsLines(rows: FormatStats[]): string[] {
  const lines = [
    "format\tgenerated\tapproved\trejected\tpublished\treplies\treposts\tbookmarks\ttags",
  ];
  for (const r of rows) {
    lines.push(
      `${r.format}\t${r.generated}\t${r.approved}\t${r.rejected}\t${r.published}\t${r.reception.replies}\t${r.reception.reposts}\t${r.reception.bookmarks}\t${r.reception.tags}`,
    );
  }
  return lines;
}
