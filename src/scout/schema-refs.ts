const CYPHER_NOISE = new Set([
  "AND",
  "AS",
  "ASC",
  "BY",
  "CASE",
  "DESC",
  "DISTINCT",
  "ELSE",
  "END",
  "FALSE",
  "IN",
  "IS",
  "LIMIT",
  "MATCH",
  "NOT",
  "NULL",
  "OPTIONAL",
  "OR",
  "ORDER",
  "RETURN",
  "THEN",
  "TRUE",
  "WHEN",
  "WHERE",
  "WITH",
  "XOR",
]);

export interface CypherSchemaRefs {
  labels: string[];
  relTypes: string[];
  properties: string[];
}

function uniqueSorted(xs: Iterable<string>): string[] {
  return [...new Set(xs)].sort();
}

/**
 * Labels, relationship types, and property names referenced in Cypher.
 * Mechanical: node labels `(…:Label)`, rel types `[…:TYPE]`, and `alias.prop`.
 */
export function extractCypherSchemaRefs(cypher: string): CypherSchemaRefs {
  const labels: string[] = [];
  for (const m of cypher.matchAll(/\(\s*[\w]*\s*:(\s*[A-Za-z_][A-Za-z0-9_]*)/g)) {
    const name = m[1].trim();
    if (!CYPHER_NOISE.has(name)) labels.push(name);
  }
  const relTypes: string[] = [];
  for (const m of cypher.matchAll(/\[\s*[\w]*\s*:([A-Za-z_][A-Za-z0-9_]*(?:\s*\|\s*[A-Za-z_][A-Za-z0-9_]*)*)/g)) {
    for (const part of m[1].split("|")) {
      const name = part.trim();
      if (name && !CYPHER_NOISE.has(name)) relTypes.push(name);
    }
  }
  const properties: string[] = [];
  for (const m of cypher.matchAll(/\b[A-Za-z_]\w*\.([A-Za-z_]\w*)\b/g)) {
    properties.push(m[1]);
  }
  return {
    labels: uniqueSorted(labels),
    relTypes: uniqueSorted(relTypes),
    properties: uniqueSorted(properties),
  };
}
