import { readFile, stat } from "node:fs/promises";
import type { Config } from "./config.js";
import { assertNoKeyMaterial } from "./keys.js";
import { discoverCrawlerResources } from "./crawler-resources.js";
import {
  assertStagingResourceConfig,
  discoverResources,
  RESOURCE_INPUT_MAX_BYTES,
  type ExternalResourceInput,
  validateResourceLimit,
} from "./external-resources.js";

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

export async function runResourcesCli(
  cfg: Config,
  argv = process.argv,
): Promise<{ ok: boolean; lines: string[] }> {
  assertNoKeyMaterial();
  assertStagingResourceConfig(cfg);
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
    return { ok: true, lines: [JSON.stringify(result, null, 2)] };
  }
  if (args[0] !== "discover") {
    return {
      ok: false,
      lines: [
        "usage: --role resources discover --input <json-file> [--limit <1-100>]",
        "   or: --role resources crawl --db <sqlite-file> --source <source> --label <taxonomy-label> [--label <taxonomy-label>] [--limit <1-100>]",
      ],
    };
  }
  const inputPath = argValue("--input", argv);
  if (!inputPath) return { ok: false, lines: ["discover requires --input <json-file>"] };
  const limitRaw = argValue("--limit", argv);
  const limit = validateResourceLimit(limitRaw ? Number(limitRaw) : cfg.resourceMaxRecords);
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
  const result = discoverResources(parsed as ExternalResourceInput[], {
    category: "pubky",
    limit,
    configVersion: cfg.resourceConfigVersion,
    disabledSources: [...cfg.resourceDisabledSources],
    disabledFamilies: [...cfg.resourceDisabledFamilies],
  });
  return { ok: true, lines: [JSON.stringify(result, null, 2)] };
}
