type Rec = Record<string, unknown>;

export const THREAD_NAME_LOOKUP_MAX = 8;
export const THREAD_NAME_LOOKUP_CONCURRENCY = 4;
export const THREAD_NAME_LOOKUP_TIMEOUT_MS = 2_000;
export const THREAD_NAME_LOOKUP_MIN_REMAINING_MS = 2_000;
export const DISPLAY_NAME_MAX_CODE_POINTS = 40;

const FORMAT_CHARS = /[\p{Cf}\u200B-\u200D\u2060\uFEFF]/gu;
const CONTROL_CHARS = /[\p{Cc}\p{Zl}\p{Zp}]/gu;
const KEY_SHAPED = /\b[a-z0-9]{52}\b/i;

export type NameScreen = (value: string) => string;

export function shortKey(key: string): string {
  return `${key.slice(0, 8)}…`;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function record(value: unknown): Rec | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : null;
}

function capCodePoints(value: string, max: number): string {
  const points = Array.from(value);
  return points.length <= max ? value : points.slice(0, max).join("").trimEnd();
}

/**
 * Canonical display name for a key: control, bidi and zero-width characters stripped, whitespace
 * collapsed, NFC normalised, capped, then run through the evidence screening. Empty means nameless.
 * A name shaped like a pubky key is dropped so it cannot pass for an evidence participant.
 */
export function sanitizeDisplayName(raw: unknown, screen: NameScreen = (v) => v): string {
  const normalize = (value: string) => value.normalize("NFC").replace(FORMAT_CHARS, "").replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
  const full = normalize(text(raw));
  if (!full || KEY_SHAPED.test(full)) return "";
  const screened = normalize(capCodePoints(normalize(screen(capCodePoints(full, DISPLAY_NAME_MAX_CODE_POINTS))), DISPLAY_NAME_MAX_CODE_POINTS));
  if (!screened || KEY_SHAPED.test(screened)) return "";
  return screened;
}

/** Display names already present on thread rows: author_name per author_id, tagger_names per tagger id. */
export function namesFromThreadPosts(posts: Rec[], screen?: NameScreen): Map<string, string> {
  const names = new Map<string, string>();
  const put = (id: string, raw: unknown) => {
    if (!id || names.has(id)) return;
    const name = sanitizeDisplayName(raw, screen);
    if (name) names.set(id, name);
  };
  for (const post of posts) {
    put(text(post.author_id), post.author_name);
    const taggerNames = record(post.tagger_names);
    if (!taggerNames) continue;
    for (const [id, name] of Object.entries(taggerNames)) put(id, name);
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

export type NameLookup = (id: string, signal: AbortSignal) => Promise<{ name?: string | null } | null>;

export type NameLookupBudget = { remaining: number };

async function lookupOne(id: string, lookup: NameLookup, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const details = await lookup(id, controller.signal);
    return details?.name;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** Two keys with the same display name get the short key appended so each stays attributable. */
function disambiguate(names: Map<string, string>): Map<string, string> {
  const byName = new Map<string, string[]>();
  for (const [id, name] of names) {
    const key = name.toLocaleLowerCase("en-US");
    byName.set(key, [...(byName.get(key) ?? []), id]);
  }
  const out = new Map<string, string>();
  for (const [id, name] of names) {
    const shared = (byName.get(name.toLocaleLowerCase("en-US")) ?? []).length > 1;
    out.set(id, shared ? `${name} (${shortKey(id)})` : name);
  }
  return out;
}

/**
 * Fills author_name and tagger_names on thread rows. Names already on a row (Scout join) win; the
 * rest are looked up through Nexus user details with bounded concurrency, a shared lookup budget,
 * a per-request abort signal and the remaining wall time. Every name is sanitized and screened.
 * A key with no name stays nameless so callers render the short key form.
 */
export async function resolveThreadNames(
  posts: Rec[],
  lookup: NameLookup | undefined,
  remainingMs: () => number,
  opts: { screen?: NameScreen; budget?: NameLookupBudget } = {},
): Promise<{ posts: Rec[]; names: Map<string, string> }> {
  const names = namesFromThreadPosts(posts, opts.screen);
  const budget = opts.budget ?? { remaining: THREAD_NAME_LOOKUP_MAX };
  if (lookup) {
    const wanted: string[] = [];
    for (const post of posts) {
      for (const id of [text(post.author_id), ...taggerIds(post)]) {
        if (id && !names.has(id) && !wanted.includes(id)) wanted.push(id);
      }
    }
    const queue = wanted.slice();
    const worker = async () => {
      for (;;) {
        const wall = remainingMs() - THREAD_NAME_LOOKUP_MIN_REMAINING_MS;
        if (wall <= 0 || budget.remaining <= 0) return;
        const id = queue.shift();
        if (!id) return;
        budget.remaining -= 1;
        const name = sanitizeDisplayName(
          await lookupOne(id, lookup, Math.min(THREAD_NAME_LOOKUP_TIMEOUT_MS, wall)),
          opts.screen,
        );
        if (name) names.set(id, name);
      }
    };
    await Promise.all(Array.from({ length: THREAD_NAME_LOOKUP_CONCURRENCY }, worker));
  }
  const labels = disambiguate(names);
  const enriched = posts.map((post) => {
    const author = text(post.author_id);
    const tagger_names: Record<string, string> = {};
    for (const id of taggerIds(post)) {
      const name = labels.get(id);
      if (name) tagger_names[id] = name;
    }
    return { ...post, author_name: (author && labels.get(author)) || "", tagger_names };
  });
  return { posts: enriched, names: labels };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Participants a summary actually names: whole-token match on the full key, the display label or
 * the short key. Longer labels are matched first and masked so a name that is a substring of
 * another never counts twice; a label shared by two participants credits neither.
 */
export function countCitedParticipants(
  summary: string,
  keys: Iterable<string>,
  names: Map<string, string>,
): number {
  const unique = [...new Set(keys)];
  const labelOf = (key: string) => (names.get(key) ?? shortKey(key)).normalize("NFC").toLocaleLowerCase("en-US");
  const seen = new Map<string, number>();
  for (const key of unique) seen.set(labelOf(key), (seen.get(labelOf(key)) ?? 0) + 1);
  const candidates = unique
    .filter((key) => seen.get(labelOf(key)) === 1)
    .sort((a, b) => labelOf(b).length - labelOf(a).length);
  let rest = summary.normalize("NFC").toLocaleLowerCase("en-US");
  let credited = 0;
  for (const key of candidates) {
    for (const needle of [key, labelOf(key)]) {
      const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(needle)}(?![\\p{L}\\p{N}])`, "gu");
      if (pattern.test(rest)) {
        credited += 1;
        rest = rest.replace(pattern, " ");
        break;
      }
    }
  }
  return credited;
}
