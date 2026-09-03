export interface GuardResult {
  ok: boolean;
  reason?: string;
  cypher?: string;
  limit?: number;
}

const WRITE =
  /\b(CREATE|MERGE|SET|DELETE|DETACH|REMOVE|DROP|FOREACH|LOAD|INSERT|DELETE)\b/i;
const ADMIN = /\b(USE|SHOW|PROFILE|EXPLAIN|USING)\b/i;
const PROC = /\bCALL\s+(db|apoc|gds|dbms)\s*\./i;
const CALL_ANY = /\bCALL\b/i;
const COMMENT = /\/\/|\/\*|\*\//;
const SEMI = /;/;
const START = /^(MATCH|OPTIONAL\s+MATCH|WITH|UNWIND|RETURN)\b/i;

const USER_PROPS = ["name", "bio", "status", "links", "image", "indexed_at", "id"];

export function clampRawLimit(cypher: string, max: number): { cypher: string; limit: number } | null {
  const m = /\bLIMIT\s+(\d+)\s*$/i.exec(cypher.trim());
  if (!m) return null;
  const n = Math.min(max, Math.max(1, parseInt(m[1], 10)));
  return { cypher: cypher.trim().replace(/\bLIMIT\s+\d+\s*$/i, `LIMIT ${n}`), limit: n };
}

function quotedStrings(cypher: string): string[] {
  const out: string[] = [];
  const re = /'((?:\\'|[^'])*)'|"((?:\\"|[^"])*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cypher))) {
    out.push(m[1] ?? m[2] ?? "");
  }
  return out;
}

export function looksLikeUserText(s: string): boolean {
  if (s.length < 3) return false;
  if (/^[0-9]+$/.test(s)) return false;
  if (/^[A-Z0-9_]{2,}$/.test(s) && s.length <= 20) return false;
  return /[a-zA-Z]/.test(s);
}

function returnedUserProps(cypher: string): number {
  const ret = cypher.split(/\bRETURN\b/i).pop() ?? "";
  let n = 0;
  for (const p of USER_PROPS) {
    if (new RegExp(`\\b\\w+\\.${p}\\b`, "i").test(ret)) n += 1;
  }
  return n;
}

/** Variables bound to a :User node, e.g. `u` in `(u:User ...)`. */
function userVars(cypher: string): string[] {
  const vars = new Set<string>();
  for (const m of cypher.matchAll(/\(\s*(\w+)\s*:\s*User\b/gi)) vars.add(m[1]);
  return [...vars];
}

/**
 * A User is id-bound when its identity is pinned by any of:
 * `(u:User {id: ...})`, `(:User {id: ...})`, `WHERE u.id = ...`,
 * or `u.id IN [...]`. Binding via WHERE used to evade the denylist.
 */
function hasIdBoundUser(cypher: string): boolean {
  if (/\(\s*(\w+\s*)?:\s*User\s*\{[^}]*\bid\s*:/i.test(cypher)) return true;
  for (const v of userVars(cypher)) {
    const whereBind = new RegExp(`\\b${v}\\s*\\.\\s*id\\s*(=|IN\\b)`, "i");
    if (whereBind.test(cypher)) return true;
  }
  return false;
}

/**
 * Person-profiling denylist. Once a single user is id-bound and their
 * AUTHORED posts are traversed, the query may not return that user's post
 * bodies, collect their posts, or combine more than maxProps of their
 * profile properties with the traversal. The rules apply independently —
 * collecting post content with zero user props is still profiling.
 */
export function checkProfilingDenylist(cypher: string, maxProps: number): GuardResult {
  if (!/:AUTHORED\b/i.test(cypher)) return { ok: true };
  if (!hasIdBoundUser(cypher)) return { ok: true };
  if (/\.(content|attachments)\b/i.test(cypher)) {
    return { ok: false, reason: "person-profiling denylist: post content of an id-bound user" };
  }
  const collectsNode = /\bcollect\s*\(\s*\w+\s*\)/i.test(cypher);
  const aggregateOnly = /\b(size|count)\s*\(\s*collect\s*\(/i.test(cypher);
  if (collectsNode && !aggregateOnly) {
    return { ok: false, reason: "person-profiling denylist: post history collect against an id-bound user" };
  }
  const props = returnedUserProps(cypher);
  if (props > maxProps) {
    return {
      ok: false,
      reason: `person-profiling denylist: more than ${maxProps} User properties plus post history in one query`,
    };
  }
  return { ok: true };
}

/**
 * Rejects unbounded variable-length relationship paths in raw mode:
 * `[*]`, `[*..]`, `[*N..]` have no upper hop bound. Bounded forms
 * (`*N`, `*..N`, `*N..M`) are allowed. Only inspected inside relationship
 * brackets so `count(*)` arithmetic is unaffected.
 */
export function hasUnboundedVarlenPath(cypher: string): boolean {
  for (const b of cypher.matchAll(/\[[^\]]*\]/g)) {
    const inner = b[0];
    const star = /\*(\d*)(?:\.{1,2}(\d*))?/.exec(inner);
    if (!star) continue;
    if (!star[1] && !star[2]) return true; // bare * or *..
    if (/\.\./.test(inner.slice(inner.indexOf("*"))) && !star[2]) return true; // *N.. open upper
  }
  return false;
}

export function guardRawCypher(
  cypher: string,
  params: Record<string, unknown>,
  opts: { limitMax: number; profilePropMax: number; rawEnabled: boolean },
): GuardResult {
  if (!opts.rawEnabled) return { ok: false, reason: "raw cypher disabled" };
  const trimmed = cypher.trim();
  if (!trimmed) return { ok: false, reason: "empty cypher" };
  if (trimmed.length > 2000) return { ok: false, reason: "cypher too long" };
  if (SEMI.test(trimmed)) return { ok: false, reason: "multiple statements / semicolon rejected" };
  if (COMMENT.test(trimmed)) return { ok: false, reason: "comments rejected" };
  if (WRITE.test(trimmed)) return { ok: false, reason: "write clause rejected" };
  if (ADMIN.test(trimmed)) return { ok: false, reason: "admin/hint clause rejected" };
  if (PROC.test(trimmed)) return { ok: false, reason: "namespaced CALL rejected" };
  if (CALL_ANY.test(trimmed)) return { ok: false, reason: "Scout does not permit CALL" };
  if (!START.test(trimmed)) return { ok: false, reason: "must start with MATCH/WITH/OPTIONAL MATCH/UNWIND/RETURN" };
  if (/\bLOAD\s+CSV\b/i.test(trimmed)) return { ok: false, reason: "LOAD CSV rejected" };
  if (hasUnboundedVarlenPath(trimmed)) return { ok: false, reason: "unbounded variable-length path rejected" };
  const lim = clampRawLimit(trimmed, opts.limitMax);
  if (!lim) return { ok: false, reason: "LIMIT required" };
  const literals = quotedStrings(lim.cypher);
  const paramValues = new Set(Object.values(params).map((v) => String(v)));
  for (const lit of literals) {
    if (looksLikeUserText(lit) && !paramValues.has(lit)) {
      return { ok: false, reason: "user text must be passed as params, not Cypher literals" };
    }
  }
  const profile = checkProfilingDenylist(lim.cypher, opts.profilePropMax);
  if (!profile.ok) return profile;
  return { ok: true, cypher: lim.cypher, limit: lim.limit };
}
