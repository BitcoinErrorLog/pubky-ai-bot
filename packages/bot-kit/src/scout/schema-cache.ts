import { log } from "../log.js";
import type { ScoutSchemaCacheConfig } from "./scout-config.js";
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

export const SCHEMA_RETRY_INITIAL_MS = 30_000;
export const SCHEMA_RETRY_CAP_MS = 5 * 60_000;

let golden: ScoutGraph | null = null;
let active: ScoutGraph | null = null;
let source: SchemaSource = "golden";
let fetchedAt = new Date(0).toISOString();
let fallbackCount = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;
let retryMs = SCHEMA_RETRY_INITIAL_MS;

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
  cfg: ScoutSchemaCacheConfig,
  shared?: Pick<ScoutClient, "schema">,
  opts?: { switchBlocked?: () => Promise<boolean> },
): void {
  ensureActive();
  if (started) return;
  started = true;
  if (process.env.JEB_CONTRACT_MODE === "1") return;
  const client = shared ?? new ScoutClient({ ...cfg, scoutLimitMax: 50 });
  const interval = cfg.scoutSchemaRefreshMs;
  retryMs = SCHEMA_RETRY_INITIAL_MS;

  const schedule = (delay: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void tick();
    }, delay);
    timer.unref?.();
  };

  const tick = async () => {
    if (opts?.switchBlocked && (await opts.switchBlocked())) {
      schedule(source !== "live" ? retryMs : interval);
      return;
    }
    try {
      await refreshScoutSchema(client);
    } catch (e) {
      log.warn({ err: e instanceof Error ? e.message : String(e) }, "scout schema refresh tick failed");
    }
    if (source !== "live") {
      const delay = retryMs;
      retryMs = Math.min(retryMs * 2, SCHEMA_RETRY_CAP_MS);
      schedule(delay);
      return;
    }
    retryMs = SCHEMA_RETRY_INITIAL_MS;
    schedule(interval);
  };

  if (source !== "live") {
    schedule(0);
  } else {
    schedule(interval);
  }
}

export function stopScoutSchemaCache(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  started = false;
  retryMs = SCHEMA_RETRY_INITIAL_MS;
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
