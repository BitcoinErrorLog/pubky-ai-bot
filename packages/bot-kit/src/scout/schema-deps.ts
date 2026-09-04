import { extractCypherSchemaRefs } from "./schema-refs.js";
import { allTemplateCyphers } from "./templates.js";

export interface TemplateSchemaDeps {
  labels: string[];
  relTypes: string[];
  properties: string[];
}

/** Union of labels, rel types, and properties actually referenced by product templates. */
export function templateSchemaDeps(): TemplateSchemaDeps {
  const labels = new Set<string>();
  const relTypes = new Set<string>();
  const properties = new Set<string>();
  for (const q of allTemplateCyphers()) {
    const refs = extractCypherSchemaRefs(q.cypher);
    for (const l of refs.labels) labels.add(l);
    for (const r of refs.relTypes) relTypes.add(r);
    for (const p of refs.properties) properties.add(p);
  }
  return {
    labels: [...labels].sort(),
    relTypes: [...relTypes].sort(),
    properties: [...properties].sort(),
  };
}

export function missingTemplateDeps(
  schema: { labels: Set<string>; relTypes: Set<string>; properties: Set<string> },
  deps = templateSchemaDeps(),
): { labels: string[]; relTypes: string[]; properties: string[] } {
  return {
    labels: deps.labels.filter((l) => !schema.labels.has(l)),
    relTypes: deps.relTypes.filter((r) => !schema.relTypes.has(r)),
    properties: deps.properties.filter((p) => !schema.properties.has(p)),
  };
}
