import fs from "node:fs";
import { parse as parseYaml } from "yaml";
import { CONFIDENTIALITY, SOURCE_KINDS, SOURCE_STATUSES, type Manifest, type SourceEntry } from "./types.js";

function parseEnabled(v: unknown, index: number): boolean {
  if (v === undefined || v === null) return true;
  if (v === false || v === "false") return false;
  if (v === true || v === "true") return true;
  throw new Error(`sources[${index}].enabled must be a boolean`);
}

function asStringArray(v: unknown, field: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new Error(`manifest ${field} must be a string array`);
  }
  return v as string[];
}

function parseEntry(raw: unknown, index: number): SourceEntry {
  if (!raw || typeof raw !== "object") throw new Error(`manifest sources[${index}] must be an object`);
  const o = raw as Record<string, unknown>;
  const id = o.id;
  const product = o.product;
  const component = o.component;
  const kind = o.kind;
  const location = o.location;
  const status = o.status;
  const audience = o.audience;
  const confidentiality = o.confidentiality;
  const owner = o.owner;
  if (typeof id !== "string" || !id) throw new Error(`manifest sources[${index}].id required`);
  if (typeof product !== "string" || !product) throw new Error(`sources[${index}].product required`);
  if (typeof component !== "string" || !component) throw new Error(`sources[${index}].component required`);
  if (typeof kind !== "string" || !SOURCE_KINDS.includes(kind as never)) {
    throw new Error(`sources[${index}].kind invalid`);
  }
  if (typeof location !== "string" || !location) throw new Error(`sources[${index}].location required`);
  if (typeof status !== "string" || !SOURCE_STATUSES.includes(status as never)) {
    throw new Error(`sources[${index}].status invalid`);
  }
  if (typeof audience !== "string" || !audience) throw new Error(`sources[${index}].audience required`);
  if (typeof confidentiality !== "string" || !CONFIDENTIALITY.includes(confidentiality as never)) {
    throw new Error(`sources[${index}].confidentiality invalid`);
  }
  if (typeof owner !== "string" || !owner) throw new Error(`sources[${index}].owner required`);
  return {
    id,
    product,
    component,
    kind: kind as SourceEntry["kind"],
    location,
    include: asStringArray(o.include, `sources[${index}].include`),
    exclude: asStringArray(o.exclude, `sources[${index}].exclude`),
    status: status as SourceEntry["status"],
    audience,
    confidentiality: confidentiality as SourceEntry["confidentiality"],
    owner,
    cite_base: typeof o.cite_base === "string" ? o.cite_base : undefined,
    ref: typeof o.ref === "string" ? o.ref : undefined,
    enabled: parseEnabled(o.enabled, index),
    nexus: typeof o.nexus === "string" ? o.nexus : undefined,
    max_pages: typeof o.max_pages === "number" && Number.isFinite(o.max_pages) ? o.max_pages : undefined,
    allow_paths: o.allow_paths === undefined ? undefined : asStringArray(o.allow_paths, `sources[${index}].allow_paths`),
  };
}

export function parseManifest(yamlText: string): Manifest {
  const doc = parseYaml(yamlText) as unknown;
  if (!doc || typeof doc !== "object" || !("sources" in doc)) {
    throw new Error("manifest must have sources");
  }
  const sourcesRaw = (doc as { sources: unknown }).sources;
  if (!Array.isArray(sourcesRaw)) throw new Error("manifest sources must be an array");
  const sources = sourcesRaw.map(parseEntry);
  const ids = new Set<string>();
  for (const s of sources) {
    if (ids.has(s.id)) throw new Error(`duplicate source id ${s.id}`);
    ids.add(s.id);
  }
  return { sources };
}

export function loadManifest(filePath: string): Manifest {
  return parseManifest(fs.readFileSync(filePath, "utf8"));
}
