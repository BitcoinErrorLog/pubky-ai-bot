import { readFile, stat } from "node:fs/promises";
import type { Config } from "./config.js";
import { assertNoKeyMaterial } from "./keys.js";
import { discoverCrawlerResources } from "./crawler-resources.js";
import {
  assertStagingResourceConfig,
  discoverResources,
  RESOURCE_INPUT_MAX_BYTES,
  type ExternalResourceInput,
  type ResourceRun,
  validateResourceLimit,
} from "./external-resources.js";
import { openTransport, type Transport } from "./homeserver.js";
import { publishResourceTags, type ResourcePublishManifest } from "./resource-publish.js";

function argValue(flag: string, argv: string[]): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("-") ? argv[i + 1] : undefined;
}

function argValues(flag: string, argv: string[]): string[] {
  const values: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === flag && argv[i + 1] && !argv[i + 1].startsWith("-")) values.push(argv[i + 1]!);
  }
  return values;
}

function argvAfterRole(argv: string[]): string[] {
  const roleIdx = argv.indexOf("--role");
  return roleIdx >= 0 ? argv.slice(roleIdx + 2) : argv.slice(2);
}

export function resourceCliMode(argv: string[], fallback: Config["resourceMode"]): Config["resourceMode"] {
  const raw = (argValue("--mode", argv) ?? fallback).trim().toLowerCase();
  if (raw === "shadow" || raw === "publish") return raw;
  throw new Error("invalid --mode (shadow|publish)");
}

export function resourceCliTarget(argv: string[], fallback: Config["resourceTarget"]): Config["resourceTarget"] {
  const raw = (argValue("--target", argv) ?? fallback).trim().toLowerCase();
  if (raw === "staging" || raw === "production") return raw;
  throw new Error("invalid --target (staging|production)");
}

export type ResourcesCliDeps = {
  transport?: Transport;
  openTransport?: typeof openTransport;
};

const USAGE = [
  "usage: --role resources discover --input <json-file> [--limit <1-100>] [--mode shadow|publish] [--target staging]",
  "   or: --role resources crawl --db <sqlite-file> --source <source> --label <taxonomy-label> [--label <taxonomy-label>] [--limit <1-100>] [--mode shadow|publish] [--target staging]",
];

async function loadDiscoverInput(inputPath: string, limit: number, cfg: Config): Promise<ResourceRun> {
  const fileStat = await stat(inputPath);
  if (!fileStat.isFile()) throw new Error("resource input must be a regular file");
  if (fileStat.size > RESOURCE_INPUT_MAX_BYTES) {
    throw new Error(`resource input file must be no larger than ${RESOURCE_INPUT_MAX_BYTES} bytes`);
  }
  const input = await readFile(inputPath);
  if (input.byteLength > RESOURCE_INPUT_MAX_BYTES) {
    throw new Error(`resource input file must be no larger than ${RESOURCE_INPUT_MAX_BYTES} bytes`);
  }
  const parsed: unknown = JSON.parse(input.toString("utf8"));
  if (!Array.isArray(parsed)) throw new Error("resource input must be a JSON array");
  return discoverResources(parsed as ExternalResourceInput[], {
    category: "pubky",
    limit,
    configVersion: cfg.resourceConfigVersion,
    disabledSources: [...cfg.resourceDisabledSources],
    disabledFamilies: [...cfg.resourceDisabledFamilies],
  });
}

async function maybePublish(
  run: ResourceRun,
  cfg: Config,
  argv: string[],
  deps?: ResourcesCliDeps,
): Promise<{ ok: boolean; payload: ResourceRun & { publish?: ResourcePublishManifest } }> {
  const mode = resourceCliMode(argv, cfg.resourceMode);
  const target = resourceCliTarget(argv, cfg.resourceTarget);
  const effective = { ...cfg, resourceMode: mode, resourceTarget: target };
  assertStagingResourceConfig(effective);
  if (mode === "shadow") {
    return { ok: true, payload: { ...run, mode: "shadow" } };
  }
  const transport =
    deps?.transport ??
    (await (deps?.openTransport ?? openTransport)({
      secretKeyHex: cfg.secretKeyHex,
      homeserverPk: cfg.homeserverPk,
      signupToken: cfg.signupToken,
      testnet: cfg.testnet,
    }));
  const publish = await publishResourceTags(run.accepted, effective, transport);
  return {
    ok: publish.failed === 0,
    payload: { ...run, mode: "publish", publish },
  };
}

export async function runResourcesCli(
  cfg: Config,
  argv = process.argv,
  deps?: ResourcesCliDeps,
): Promise<{ ok: boolean; lines: string[] }> {
  const mode = resourceCliMode(argv, cfg.resourceMode);
  const target = resourceCliTarget(argv, cfg.resourceTarget);
  const effective = { ...cfg, resourceMode: mode, resourceTarget: target };
  if (mode === "shadow") assertNoKeyMaterial();
  assertStagingResourceConfig(effective);
  const args = argvAfterRole(argv);
  if (args[0] === "crawl") {
    const dbPath = argValue("--db", argv);
    const source = argValue("--source", argv);
    const labels = argValues("--label", argv);
    const limitRaw = argValue("--limit", argv);
    const limit = validateResourceLimit(limitRaw ? Number(limitRaw) : cfg.resourceMaxRecords);
    const result = await discoverCrawlerResources({
      dbPath: dbPath ?? "",
      source: source ?? "",
      labels,
      limit,
    });
    const published = await maybePublish(result, effective, argv, deps);
    return { ok: published.ok, lines: [JSON.stringify(published.payload, null, 2)] };
  }
  if (args[0] !== "discover") {
    return { ok: false, lines: USAGE };
  }
  const inputPath = argValue("--input", argv);
  if (!inputPath) return { ok: false, lines: ["discover requires --input <json-file>"] };
  const limitRaw = argValue("--limit", argv);
  const limit = validateResourceLimit(limitRaw ? Number(limitRaw) : cfg.resourceMaxRecords);
  const result = await loadDiscoverInput(inputPath, limit, cfg);
  const published = await maybePublish(result, effective, argv, deps);
  return { ok: published.ok, lines: [JSON.stringify(published.payload, null, 2)] };
}
