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

export function checkProfilingDenylist(cypher: string, maxProps: number): GuardResult {
  const boundUser = /:User\s*\{[^}]*\bid\b/i.test(cypher) || /:User\s*\w*\s*\{[^}]*id:/i.test(cypher);
  const authored = /:AUTHORED\b/i.test(cypher);
  const postBody = /\.(content|attachments)\b/i.test(cypher);
  const props = returnedUserProps(cypher);
  if (boundUser && authored && postBody && props > maxProps) {
    return {
      ok: false,
      reason: `person-profiling denylist: more than ${maxProps} User properties plus post history in one query`,
    };
  }
  if (boundUser && authored && /\bcollect\s*\(\s*\w+\s*\)/i.test(cypher) && !/\bLIMIT\b/i.test(cypher.split(/AUTHORED/i).pop() ?? "")) {
    return { ok: false, reason: "person-profiling denylist: unbounded post history collect" };
  }
  return { ok: true };
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
