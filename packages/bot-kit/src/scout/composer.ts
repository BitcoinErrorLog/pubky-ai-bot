import { createHash } from "node:crypto";
import { Z32 } from "../types.js";
import { checkSchemaBound, guardRawCypher, type GuardResult } from "./guard.js";
import { graphIndex, type ScoutGraph } from "./schema-model.js";

export type LiveSchemaSummary = ScoutGraph;

export enum ComposerErrorCode {
  EMPTY_QUERY = "EMPTY_QUERY",
  QUERY_TOO_LONG = "QUERY_TOO_LONG",
  QUERY_NOT_READ_ONLY = "QUERY_NOT_READ_ONLY",
  QUERY_START = "QUERY_START",
  MULTIPLE_STATEMENTS = "MULTIPLE_STATEMENTS",
  COMMENT = "COMMENT",
  UNBOUNDED_PATH = "UNBOUNDED_PATH",
  LIMIT_REQUIRED = "LIMIT_REQUIRED",
  LIMIT_TOO_HIGH = "LIMIT_TOO_HIGH",
  CARTESIAN_PRODUCT = "CARTESIAN_PRODUCT",
  OPTIONAL_MATCH_CAP = "OPTIONAL_MATCH_CAP",
  ORDER_BY_UNINDEXED = "ORDER_BY_UNINDEXED",
  ANCHOR_REQUIRED = "ANCHOR_REQUIRED",
  PARAM_REQUIRED = "PARAM_REQUIRED",
  LITERAL_LEAK = "LITERAL_LEAK",
  TENANT_PARAM_REJECTED = "TENANT_PARAM_REJECTED",
  OWNER_ANCHOR_REQUIRED = "OWNER_ANCHOR_REQUIRED",
  SCHEMA = "SCHEMA",
  MUTED_VISIBILITY = "MUTED_VISIBILITY",
  PARAM_INVALID = "PARAM_INVALID",
  COST = "COST",
}

export const COMPOSER_HINTS: Record<ComposerErrorCode, string> = {
  EMPTY_QUERY: "Provide one bounded read query.",
  QUERY_TOO_LONG: "Shorten the read query.",
  QUERY_NOT_READ_ONLY: "Use a read-only graph query.",
  QUERY_START: "Start with MATCH, OPTIONAL MATCH, WITH, UNWIND, or RETURN.",
  MULTIPLE_STATEMENTS: "Submit one graph statement.",
  COMMENT: "Remove comments from the graph query.",
  UNBOUNDED_PATH: "Bound every relationship path.",
  LIMIT_REQUIRED: "End the query with LIMIT 1 through 50.",
  LIMIT_TOO_HIGH: "Lower the terminal LIMIT to 50 or less.",
  CARTESIAN_PRODUCT: "Connect each later MATCH to an existing variable.",
  OPTIONAL_MATCH_CAP: "Use no more than two OPTIONAL MATCH clauses.",
  ORDER_BY_UNINDEXED: "Order only by an indexed property or an aggregate.",
  ANCHOR_REQUIRED: "Start with a selective indexed or id parameter anchor.",
  PARAM_REQUIRED: "Pass user-derived values as parameters.",
  LITERAL_LEAK: "Pass question and context text as parameters.",
  TENANT_PARAM_REJECTED: "The service supplies the tenant owner.",
  OWNER_ANCHOR_REQUIRED: "Anchor owner-network queries on the service owner.",
  SCHEMA: "Use only identifiers from the live Scout schema.",
  MUTED_VISIBILITY: "Muted edges may only be returned as owner-anchored aggregates.",
  PARAM_INVALID: "Use valid Pubky, URI, and timestamp parameter values.",
  COST: "Reduce the query scope or number of graph expansions.",
};

export type ComposeOk = {
  ok: true;
  cypher: string;
  params: Record<string, unknown>;
  limit: number;
  anchors: string[];
};
export type ComposeError = {
  ok: false;
  code: ComposerErrorCode;
  hint: string;
  path?: string;
};

export type ComposeInput = {
  query: string;
  params: Record<string, unknown>;
  tenant: { owner: string };
  schema: LiveSchemaSummary;
  untrustedTexts: string[];
  scopeKind?: "whole_graph" | "owner_network";
};

const readOnlyStart = /^(MATCH|OPTIONAL\s+MATCH|WITH|UNWIND|RETURN)\b/i;
const forbidden = /\b(CREATE|MERGE|SET|DELETE|DETACH|REMOVE|DROP|FOREACH|INSERT|LOAD\s+CSV|CALL|USE|SHOW|PROFILE|EXPLAIN|USING)\b/i;
const comments = /\/\/|\/\*|\*\//;
const quoted = /'((?:\\'|[^'])*)'|"((?:\\"|[^"])*)"/g;
const timeName = /(since|until|time|timestamp|created_at|indexed_at|date)/i;
const publicUri = /^pubky:\/\/[ybndrfg8ejkmcpqxot1uwisza345h769]{52}\/pub\/pubky\.app\/(?:posts|tags|follows|mutes|bookmarks|feeds|files|profile\.json)(?:\/[^/?#]+)?$/;

function fail(code: ComposerErrorCode, path?: string): ComposeError {
  return { ok: false, code, hint: COMPOSER_HINTS[code], ...(path ? { path } : {}) };
}

function normalized(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function values(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(values);
  if (value && typeof value === "object") return Object.values(value).flatMap(values);
  return [value];
}

function validateParam(name: string, value: unknown): boolean {
  const lower = name.toLowerCase();
  if (/(owner|user|pubky)/.test(lower)) return typeof value === "string" && Z32.test(value);
  if (lower.includes("uri")) return typeof value === "string" && publicUri.test(value);
  if (timeName.test(lower)) {
    return (typeof value === "number" && Number.isInteger(value) && value >= 0) ||
      (typeof value === "string" && !Number.isNaN(Date.parse(value)));
  }
  return true;
}

export function revalidateResolvedParams(params: Record<string, unknown>): void {
  for (const [name, value] of Object.entries(params)) {
    for (const item of values(value)) {
      if (!validateParam(name, item)) throw new Error(`invalid composed parameter: ${name}`);
    }
  }
}

function terminalLimit(query: string): number | null {
  const match = /\bLIMIT\s+(\d+)\s*$/i.exec(query.trim());
  return match ? Number(match[1]) : null;
}

function selectiveAnchor(query: string): boolean {
  const first = /^\s*MATCH\s+([\s\S]*?)(?=\b(?:OPTIONAL\s+MATCH|MATCH|WITH|RETURN|UNWIND)\b)/i.exec(query);
  const clause = first?.[1] ?? query;
  return /\{\s*id\s*:\s*\$(?:owner|[A-Za-z_]\w*)\s*\}/i.test(clause) ||
    /\b\w+\.(?:indexed_at|created_at)\s*(?:=|IN|>=|>|<=|<)\s*\$[A-Za-z_]\w*/i.test(clause);
}

function checkMatchBindings(query: string): boolean {
  const clauses = [...query.matchAll(/\b(?:OPTIONAL\s+)?MATCH\b([\s\S]*?)(?=\b(?:OPTIONAL\s+MATCH|MATCH|WITH|RETURN|UNWIND)\b|$)/gi)];
  if (clauses.length < 2) return true;
  const bound = new Set<string>();
  for (const [index, clause] of clauses.entries()) {
    const vars = [...clause[1].matchAll(/\(\s*([A-Za-z_]\w*)\s*(?::|\))/g)].map((m) => m[1]);
    if (index > 0 && !vars.some((v) => bound.has(v))) return false;
    vars.forEach((v) => bound.add(v));
  }
  return true;
}

function hasOnlySafeLiterals(query: string, params: Record<string, unknown>, untrustedTexts: string[], schema: ScoutGraph): boolean {
  const labels = graphIndex(schema).labels;
  const paramStrings = new Set(values(params).filter((v): v is string => typeof v === "string").map(normalized));
  for (const match of query.matchAll(quoted)) {
    const literal = normalized(match[1] ?? match[2] ?? "");
    if (untrustedTexts.some((text) => literal.length >= 8 && normalized(text).includes(literal))) return false;
    if (literal.length >= 8 && !paramStrings.has(literal) && !labels.has(literal)) return false;
  }
  return true;
}

function guardMutedComposer(query: string): boolean {
  if (!/:MUTED\b/i.test(query)) return true;
  const ownerAnchor = /\(\s*\w*\s*:\s*User\s*\{\s*id\s*:\s*\$owner\s*\}\s*\)/i.test(query) ||
    /\b\w+\.id\s*=\s*\$owner\b/i.test(query);
  const returned = query.split(/\bRETURN\b/i).pop() ?? "";
  const aggregateOnly = !returned.replace(/\b(?:count|size)\s*\([^)]*\)/gi, "").match(/\b(?:a|b|m|w)\.(?:id|name)\b|\bm\b/);
  return ownerAnchor && aggregateOnly;
}

export function composeCypher(input: ComposeInput): ComposeOk | ComposeError {
  const query = input.query.trim();
  if (!query) return fail(ComposerErrorCode.EMPTY_QUERY);
  if (query.length > 2000) return fail(ComposerErrorCode.QUERY_TOO_LONG);
  if (comments.test(query)) return fail(ComposerErrorCode.COMMENT);
  if (query.includes(";")) return fail(ComposerErrorCode.MULTIPLE_STATEMENTS);
  if (!readOnlyStart.test(query) || forbidden.test(query)) return fail(ComposerErrorCode.QUERY_NOT_READ_ONLY);
  if (/\bCALL\s*\{/i.test(query) || /\b(?:apoc|db|dbms|gds)\./i.test(query)) return fail(ComposerErrorCode.QUERY_NOT_READ_ONLY);
  if (/\bUNWIND\s+range\s*\(/i.test(query) || /\bUNWIND\s*\[[^\]]{21,}\]/i.test(query)) return fail(ComposerErrorCode.COST);
  if (/\*\d*(?:\.\.?\d*)?(?:\]|\s)/.test(query) && /\[[^\]]*\*/.test(query)) {
    const bounded = [...query.matchAll(/\[[^\]]*\]/g)].every((m) => !/\*(?:\d*)?(?:\.\.)?\s*\]/.test(m[0]) || /\*\d+\.\.\d+\]/.test(m[0]) || /\*\.\.\d+\]/.test(m[0]));
    if (!bounded) return fail(ComposerErrorCode.UNBOUNDED_PATH);
  }
  const limit = terminalLimit(query);
  if (limit === null) return fail(ComposerErrorCode.LIMIT_REQUIRED);
  if (limit < 1 || limit > 50) return fail(ComposerErrorCode.LIMIT_TOO_HIGH);
  if (!guardMutedComposer(query)) return fail(ComposerErrorCode.MUTED_VISIBILITY);
  if ((query.match(/\bOPTIONAL\s+MATCH\b/gi) ?? []).length > 2) return fail(ComposerErrorCode.OPTIONAL_MATCH_CAP);
  if (!selectiveAnchor(query)) return fail(ComposerErrorCode.ANCHOR_REQUIRED);
  if (!checkMatchBindings(query)) return fail(ComposerErrorCode.CARTESIAN_PRODUCT);
  if (/\bORDER\s+BY\b/i.test(query)) {
    const order = query.split(/\bORDER\s+BY\b/i)[1]?.split(/\bLIMIT\b/i)[0] ?? "";
    const indexed = new Set(["indexed_at", "created_at"]);
    const aliases = new Set(
      [...(query.split(/\bRETURN\b/i)[1] ?? "").matchAll(/\bAS\s+([A-Za-z_]\w*)/gi)].map((m) => m[1]),
    );
    const bad = [...order.matchAll(/\b(?:\w+\.)?([A-Za-z_]\w*)\b/g)]
      .map((m) => m[1]).filter((name) => !indexed.has(name) && !aliases.has(name) &&
        !["ASC", "DESC", "DISTINCT", "count", "size", "max", "min", "avg", "sum", "AS"].includes(name));
    if (bad.length) return fail(ComposerErrorCode.ORDER_BY_UNINDEXED);
  }
  if (Object.keys(input.params).some((key) => ["owner", "asker", "tenant"].includes(key))) return fail(ComposerErrorCode.TENANT_PARAM_REJECTED);
  const params = { ...input.params, owner: input.tenant.owner };
  if (!Z32.test(input.tenant.owner)) return fail(ComposerErrorCode.PARAM_INVALID, "tenant.owner");
  if (input.scopeKind === "owner_network" && !/\(\s*\w*\s*:\s*User\s*\{\s*id\s*:\s*\$owner\s*\}\s*\)/i.test(query)) {
    return fail(ComposerErrorCode.OWNER_ANCHOR_REQUIRED);
  }
  for (const name of Object.keys(params)) if (!new RegExp(`\\$${name}\\b`).test(query) && name !== "owner") return fail(ComposerErrorCode.PARAM_REQUIRED, `params.${name}`);
  try {
    revalidateResolvedParams(params);
  } catch {
    return fail(ComposerErrorCode.PARAM_INVALID);
  }
  if (!hasOnlySafeLiterals(query, params, input.untrustedTexts, input.schema)) return fail(ComposerErrorCode.LITERAL_LEAK);
  const schema = checkSchemaBound(query, input.schema);
  if (!schema.ok) return fail(ComposerErrorCode.SCHEMA);
  const guarded: GuardResult = guardRawCypher(query, params, { limitMax: 50, profilePropMax: 3, rawEnabled: true, schema: input.schema });
  if (!guarded.ok) return fail(ComposerErrorCode.QUERY_NOT_READ_ONLY);
  const anchors = [...query.matchAll(/\$([A-Za-z_]\w*)/g)].map((m) => m[1]).filter((v, i, all) => all.indexOf(v) === i);
  return { ok: true, cypher: query, params, limit, anchors };
}

export function composerTelemetry(result: ComposeOk | ComposeError, schemaHash: string): Record<string, string | number> {
  if (!result.ok) return { code: result.code, schema_hash: schemaHash, bytes: 0 };
  const paramShape = Object.entries(result.params).sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${name}:${Array.isArray(value) ? "array" : typeof value}`).join("|");
  return {
    code: "ok",
    query_hash: hash(result.cypher),
    param_shape_hash: hash(paramShape),
    schema_hash: schemaHash,
    bytes: Buffer.byteLength(result.cypher, "utf8"),
  };
}
