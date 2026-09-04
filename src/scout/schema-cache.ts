import type { Config } from "../config.js";
import { log } from "../log.js";
import { ScoutClient } from "./client.js";
import { missingTemplateDeps, templateSchemaDeps } from "./schema-deps.js";
import {
  graphIndex,
  loadGoldenScoutGraph,
  parseScoutGraph,
  type ScoutGraph,
} from "./schema-model.js";

export type SchemaSource = "live" | "golden";

export interface SchemaHealth {
  labels: string[];
  relationshipTypes: string[];
  propertyCounts: { nodes: number; relationships: number; properties: number };
  source: SchemaSource;
  fetched_at: string;
  fallbackCount: number;
}

export interface SchemaDiff {
  extraLabels: string[];
  missingLabels: string[];
  extraRelTypes: string[];
  missingRelTypes: string[];
  extraProperties: string[];
  missingProperties: string[];
  missingTemplateLabels: string[];
  missingTemplateRelTypes: string[];
  missingTemplateProperties: string[];
}

let golden: ScoutGraph | null = null;
let active: ScoutGraph | null = null;
let source: SchemaSource = "golden";
let fetchedAt = new Date(0).toISOString();
let fallbackCount = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let started = false;

function goldenGraph(): ScoutGraph {
  if (!golden) golden = loadGoldenScoutGraph();
  return golden;
}

function ensureActive(): ScoutGraph {
  if (!active) {
    active = goldenGraph();
    source = "golden";
    fetchedAt = new Date().toISOString();
  }
  return active;
}

export function getActiveScoutSchema(): ScoutGraph {
  return ensureActive();
}

export function getScoutSchemaSource(): SchemaSource {
  ensureActive();
  return source;
}

export function schemaHealthSnapshot(): SchemaHealth {
  const schema = ensureActive();
  const idx = graphIndex(schema);
  return {
    labels: [...idx.labels].sort(),
    relationshipTypes: [...idx.relTypes].sort(),
    propertyCounts: {
      nodes: schema.nodes.length,
      relationships: schema.relationships.length,
      properties: idx.propertyCount,
    },
    source,
    fetched_at: fetchedAt,
    fallbackCount,
  };
}

export function diffScoutGraphs(live: ScoutGraph, baseline: ScoutGraph = goldenGraph()): SchemaDiff {
  const a = graphIndex(live);
  const b = graphIndex(baseline);
  const deps = missingTemplateDeps(a);
  const extra = (x: Set<string>, y: Set<string>) => [...x].filter((k) => !y.has(k)).sort();
  const missing = (x: Set<string>, y: Set<string>) => [...y].filter((k) => !x.has(k)).sort();
  return {
    extraLabels: extra(a.labels, b.labels),
    missingLabels: missing(a.labels, b.labels),
    extraRelTypes: extra(a.relTypes, b.relTypes),
    missingRelTypes: missing(a.relTypes, b.relTypes),
    extraProperties: extra(a.properties, b.properties),
    missingProperties: missing(a.properties, b.properties),
    missingTemplateLabels: deps.labels,
    missingTemplateRelTypes: deps.relTypes,
    missingTemplateProperties: deps.properties,
  };
}

export function alarmTemplateSchemaGaps(live: ScoutGraph): void {
  const missing = missingTemplateDeps(graphIndex(live), templateSchemaDeps());
  const gaps = [
    ...missing.labels.map((l) => `label:${l}`),
    ...missing.relTypes.map((r) => `rel:${r}`),
    ...missing.properties.map((p) => `prop:${p}`),
  ];
  if (gaps.length === 0) return;
  log.error(
    { event: "scout_schema_alarm", missing: gaps, deps: templateSchemaDeps() },
    "live Scout schema is missing labels, relationship types, or properties Jeb templates use",
  );
}

export async function refreshScoutSchema(
  client: Pick<ScoutClient, "schema">,
): Promise<{ ok: boolean; source: SchemaSource }> {
  try {
    const body = await client.schema();
    const parsed = parseScoutGraph(body);
    active = parsed;
    source = "live";
    fetchedAt = new Date().toISOString();
    alarmTemplateSchemaGaps(parsed);
    const d = diffScoutGraphs(parsed);
    if (
      d.missingLabels.length ||
      d.missingRelTypes.length ||
      d.missingProperties.length ||
      d.extraLabels.length ||
      d.extraRelTypes.length
    ) {
      log.warn({ event: "scout_schema_diff", diff: d }, "live Scout schema differs from golden copy");
    }
    return { ok: true, source: "live" };
  } catch (e) {
    fallbackCount += 1;
    if (!active) {
      active = goldenGraph();
      source = "golden";
      fetchedAt = new Date().toISOString();
    }
    log.warn(
      { event: "scout_schema_fallback", err: e instanceof Error ? e.message : String(e), fallbackCount },
      "Scout /v1/schema fetch failed; using cached or golden schema",
    );
    return { ok: false, source };
  }
}

export function ensureScoutSchemaCache(
  cfg: Pick<Config, "scoutUrl" | "scoutTimeoutMs" | "scoutSchemaRefreshMs">,
): void {
  ensureActive();
  if (started) return;
  started = true;
  if (process.env.JEB_CONTRACT_MODE === "1") return;
  const client = new ScoutClient({ ...cfg, scoutLimitMax: 50 });
  const tick = () => {
    void refreshScoutSchema(client).catch((e) => {
      log.warn({ err: String(e) }, "scout schema refresh tick failed");
    });
  };
  tick();
  const ms = cfg.scoutSchemaRefreshMs;
  timer = setInterval(tick, ms);
  timer.unref?.();
}

export function stopScoutSchemaCache(): void {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}

export function resetScoutSchemaCacheForTests(schema?: ScoutGraph, src: SchemaSource = "golden"): void {
  stopScoutSchemaCache();
  golden = loadGoldenScoutGraph();
  active = schema ?? golden;
  source = src;
  fetchedAt = new Date().toISOString();
  fallbackCount = 0;
}

export function setActiveScoutSchemaForTests(schema: ScoutGraph, src: SchemaSource): void {
  active = schema;
  source = src;
  fetchedAt = new Date().toISOString();
}
