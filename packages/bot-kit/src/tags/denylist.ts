/**
 * Tags must never be a person's name, handle, or pubky, and never a slur.
 * The slur list is a fixed deny set (not a model). Person tokens come from
 * the post under tagging (author name/handle/id) plus this static set of
 * operator/known-person labels that must never be used as tags.
 */
export const TAG_SLUR_DENYLIST: readonly string[] = [
  "chink",
  "coon",
  "fag",
  "faggot",
  "gook",
  "kike",
  "nigger",
  "nigga",
  "retard",
  "retarded",
  "spic",
  "tranny",
  "wetback",
];

/** Handles / display names that are people, never topic tags. */
export const TAG_PERSON_DENYLIST: readonly string[] = [
  "john",
  "john-carvalho",
  "bitcoinerrorlog",
  "paolo",
  "paolo-ardoino",
];

const Z32_PUBKY = /^[a-z0-9]{52}$/;
const HANDLE = /^@?[a-z0-9_]{2,32}$/;

export function isPubkyIdTag(label: string): boolean {
  return Z32_PUBKY.test(label);
}

export function normalizePersonToken(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^@+/, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function prefixMatchesPerson(label: string, token: string): boolean {
  if (label.length < 8 || token.length < 8) return false;
  return token.startsWith(label) || label.startsWith(token);
}

export function isDeniedPersonTag(label: string, extraTokens: readonly string[] = []): boolean {
  if (isPubkyIdTag(label)) return true;
  const n = normalizePersonToken(label);
  if (!n) return false;
  if ((TAG_PERSON_DENYLIST as readonly string[]).includes(n)) return true;
  const raw = label.trim().toLowerCase();
  for (const t of extraTokens) {
    const p = normalizePersonToken(t);
    if (p && (p === n || n === `@${p}`)) return true;
    if (p && prefixMatchesPerson(n, p)) return true;
    const rawToken = t.trim().toLowerCase();
    if (rawToken && prefixMatchesPerson(raw, rawToken)) return true;
  }
  if (label.startsWith("@") && HANDLE.test(label.toLowerCase())) return true;
  return false;
}

export function isDeniedSlurTag(label: string): boolean {
  const n = label.trim().toLowerCase();
  if ((TAG_SLUR_DENYLIST as readonly string[]).includes(n)) return true;
  for (const slur of TAG_SLUR_DENYLIST) {
    if (n === slur || n.startsWith(`${slur}-`) || n.endsWith(`-${slur}`) || n.includes(`-${slur}-`)) {
      return true;
    }
  }
  return false;
}
