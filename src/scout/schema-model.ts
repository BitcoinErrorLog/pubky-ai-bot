import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const propMetaSchema = z
  .object({
    type: z.string(),
    description: z.string().optional(),
    unique: z.boolean().optional(),
  })
  .passthrough();

const propValueSchema = z.union([propMetaSchema, z.string()]);

export const scoutNodeSchema = z
  .object({
    label: z.string().min(1),
    private: z.boolean().optional(),
    denied: z.boolean().optional(),
    properties: z.record(propValueSchema),
  })
  .passthrough();

export const scoutRelationshipSchema = z
  .object({
    type: z.string().min(1),
    from: z.string().min(1),
    to: z.string().min(1),
    description: z.string().optional(),
    private: z.boolean().optional(),
    denied: z.boolean().optional(),
    properties: z.record(propValueSchema),
  })
  .passthrough();

export const scoutGraphSchema = z
  .object({
    nodes: z.array(scoutNodeSchema).min(1),
    relationships: z.array(scoutRelationshipSchema).min(1),
    examples: z.array(z.string()).optional(),
  })
  .passthrough();

export type ScoutGraph = z.infer<typeof scoutGraphSchema>;

export function parseScoutGraph(body: unknown): ScoutGraph {
  return scoutGraphSchema.parse(body);
}

export function propNames(props: Record<string, unknown>): string[] {
  return Object.keys(props).sort();
}

export function graphIndex(schema: ScoutGraph): {
  labels: Set<string>;
  relTypes: Set<string>;
  properties: Set<string>;
  deniedLabels: Set<string>;
  deniedRels: Set<string>;
  propertyCount: number;
} {
  const labels = new Set<string>();
  const relTypes = new Set<string>();
  const properties = new Set<string>();
  const deniedLabels = new Set<string>();
  const deniedRels = new Set<string>();
  for (const n of schema.nodes) {
    labels.add(n.label);
    if (n.private === true || n.denied === true) deniedLabels.add(n.label);
    for (const k of Object.keys(n.properties)) properties.add(k);
  }
  for (const r of schema.relationships) {
    relTypes.add(r.type);
    if (r.private === true || r.denied === true) deniedRels.add(r.type);
    for (const k of Object.keys(r.properties)) properties.add(k);
  }
  return {
    labels,
    relTypes,
    properties,
    deniedLabels,
    deniedRels,
    propertyCount: properties.size,
  };
}

export function loadGoldenScoutGraph(): ScoutGraph {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "schema.golden.json"),
    path.join(process.cwd(), "src/scout/schema.golden.json"),
    path.join(process.cwd(), "dist/scout/schema.golden.json"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return parseScoutGraph(JSON.parse(readFileSync(p, "utf8")));
  }
  throw new Error("schema.golden.json not found");
}
