import { graphIndex, type ScoutGraph } from "./schema-model.js";

const MAX_CHARS = 2000;

export interface SchemaSummary {
  text: string;
  json: string;
  chars: number;
}

function propList(props: Record<string, unknown>): string {
  return Object.keys(props).sort().join(",");
}

/** Compact, deterministic schema text/JSON for an NL planner prompt. Not wired into answer.ts. */
export function summarizeScoutSchema(schema: ScoutGraph): SchemaSummary {
  const idx = graphIndex(schema);
  const nodes = [...schema.nodes].sort((a, b) => a.label.localeCompare(b.label));
  const rels = [...schema.relationships].sort((a, b) => {
    const t = a.type.localeCompare(b.type);
    if (t !== 0) return t;
    const f = a.from.localeCompare(b.from);
    if (f !== 0) return f;
    return a.to.localeCompare(b.to);
  });
  const lines: string[] = ["NODES"];
  for (const n of nodes) {
    lines.push(`${n.label}: ${propList(n.properties)}`);
  }
  lines.push("RELS");
  for (const r of rels) {
    const props = propList(r.properties);
    lines.push(`${r.type} ${r.from}->${r.to}${props ? ` (${props})` : ""}`);
  }
  let text = lines.join("\n");
  if (text.length > MAX_CHARS) text = `${text.slice(0, MAX_CHARS - 1)}…`;
  const jsonObj = {
    labels: [...idx.labels].sort(),
    rels: rels.map((r) => ({ type: r.type, from: r.from, to: r.to, properties: Object.keys(r.properties).sort() })),
    nodes: nodes.map((n) => ({ label: n.label, properties: Object.keys(n.properties).sort() })),
  };
  let json = JSON.stringify(jsonObj);
  if (json.length > MAX_CHARS) json = `${json.slice(0, MAX_CHARS - 1)}…`;
  return { text, json, chars: text.length };
}
