type Rec = Record<string, unknown>;

export const THREAD_NAME_LOOKUP_MAX = 8;
export const THREAD_NAME_LOOKUP_TIMEOUT_MS = 2_000;
export const THREAD_NAME_LOOKUP_MIN_REMAINING_MS = 2_000;

export function shortKey(key: string): string {
  return `${key.slice(0, 8)}…`;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function record(value: unknown): Rec | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : null;
}

/** Display names already present on thread rows: author_name per author_id, tagger_names per tagger id. */
export function namesFromThreadPosts(posts: Rec[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const post of posts) {
    const author = text(post.author_id);
    const authorName = text(post.author_name);
    if (author && authorName) names.set(author, authorName);
    const taggerNames = record(post.tagger_names);
    if (!taggerNames) continue;
    for (const [id, name] of Object.entries(taggerNames)) {
      const clean = text(name);
      if (clean && !names.has(id)) names.set(id, clean);
    }
  }
  return names;
}

function taggerIds(post: Rec): string[] {
  const ids = Array.isArray(post.taggers) ? post.taggers : [];
  const claims = Array.isArray(post.claims)
    ? post.claims.flatMap((claim) => {
        const row = record(claim);
        return row && Array.isArray(row.claimant_ids) ? row.claimant_ids : [];
      })
    : [];
  return [...ids, ...claims].filter((id): id is string => typeof id === "string" && id.length > 0);
}

export type NameLookup = (id: string) => Promise<{ name?: string | null } | null>;

/**
 * Fills author_name and tagger_names on thread rows. Names already on a row (Scout join) win; the
 * rest are looked up once per key through Nexus user details, bounded by count and wall time.
 * A key with no name stays nameless so callers render the short key form.
 */
export async function resolveThreadNames(
  posts: Rec[],
  lookup: NameLookup | undefined,
  remainingMs: () => number,
): Promise<{ posts: Rec[]; names: Map<string, string> }> {
  const names = namesFromThreadPosts(posts);
  if (lookup) {
    const wanted: string[] = [];
    for (const post of posts) {
      for (const id of [text(post.author_id), ...taggerIds(post)]) {
        if (id && !names.has(id) && !wanted.includes(id)) wanted.push(id);
      }
    }
    for (const id of wanted.slice(0, THREAD_NAME_LOOKUP_MAX)) {
      const budget = remainingMs() - THREAD_NAME_LOOKUP_MIN_REMAINING_MS;
      if (budget <= 0) break;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const details = await Promise.race([
          lookup(id),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("name lookup timeout")), Math.min(THREAD_NAME_LOOKUP_TIMEOUT_MS, budget));
          }),
        ]);
        const name = text(details?.name);
        if (name) names.set(id, name);
      } catch {
        // A failed lookup leaves the key nameless; the short key form is the fallback.
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
  }
  const enriched = posts.map((post) => {
    const author = text(post.author_id);
    const tagger_names: Record<string, string> = {};
    for (const id of taggerIds(post)) {
      const name = names.get(id);
      if (name) tagger_names[id] = name;
    }
    return {
      ...post,
      author_name: text(post.author_name) || (author ? names.get(author) ?? "" : ""),
      tagger_names,
    };
  });
  return { posts: enriched, names };
}
