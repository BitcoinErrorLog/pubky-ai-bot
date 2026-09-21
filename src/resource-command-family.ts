import { BITCOIN_CANON_SOURCE_ID } from "./resource-canon.js";

/** The mutually exclusive discovery families a resource run may select. */
export const RESOURCE_COMMAND_FAMILIES = ["discover", "crawl", "places", "canon", "pubky-posts"] as const;
export type ResourceCommandFamily = (typeof RESOURCE_COMMAND_FAMILIES)[number];

/** The four families selected by a positional command word. */
const POSITIONAL_FAMILIES = new Set<string>(["discover", "crawl", "places", "canon"]);

/** Selector value of `--source` that names the fifth family. */
const PUBKY_POSTS_SOURCE = "pubky-posts";

/**
 * Arguments that only make sense for one family. Supplying one for a different
 * family is an ambiguous invocation, not a harmless extra flag.
 */
const FAMILY_ONLY_ARGS: Readonly<Record<string, ResourceCommandFamily>> = {
  "--input": "discover",
  "--db": "crawl",
  "--label": "crawl",
  "--include-withdrawn": "canon",
};

type ParsedArgs = { positionals: string[]; flags: Map<string, string[]> };

/**
 * Split the post-role arguments into positional command words and flags with
 * their values. A token consumed as a flag value is never also a positional,
 * so `--source pubky-posts` does not look like a `pubky-posts` command.
 */
function parseArgs(args: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]!;
    if (!token.startsWith("-")) {
      positionals.push(token);
      continue;
    }
    const next = args[i + 1];
    const value = next !== undefined && !next.startsWith("-") ? next : undefined;
    const values = flags.get(token) ?? [];
    if (value !== undefined) {
      values.push(value);
      i += 1;
    }
    flags.set(token, values);
  }
  return { positionals, flags };
}

/**
 * Resolve exactly one discovery family, or fail. This runs before the build
 * stamp, Postgres, the model, Nexus, and any key access, because the previous
 * dispatch chain silently gave `--source pubky-posts` priority over a
 * positional command: `discover --source pubky-posts` ran a different family
 * than the operator typed.
 */
export function resolveResourceCommandFamily(args: readonly string[]): ResourceCommandFamily {
  const { positionals, flags } = parseArgs(args);
  const sources = flags.get("--source") ?? [];
  if (sources.length > 1) {
    throw new Error("resource run refused: --source may be given at most once");
  }
  const source = sources[0];
  const pubkyPostsSelected = source === PUBKY_POSTS_SOURCE;

  const unknown = positionals.filter((word) => !POSITIONAL_FAMILIES.has(word));
  if (unknown.length > 0) {
    throw new Error(`resource run refused: unknown command '${unknown[0]}'`);
  }
  const distinct = [...new Set(positionals)];
  if (distinct.length !== positionals.length) {
    throw new Error("resource run refused: repeated family command");
  }
  const selectors: string[] = [...distinct];
  if (pubkyPostsSelected) selectors.push(PUBKY_POSTS_SOURCE);
  if (selectors.length === 0) {
    throw new Error(
      `resource run refused: exactly one family is required (${RESOURCE_COMMAND_FAMILIES.join("|")})`,
    );
  }
  if (selectors.length > 1) {
    throw new Error(`resource run refused: families '${selectors.join("', '")}' are mutually exclusive`);
  }
  const family = selectors[0] as ResourceCommandFamily;

  for (const [flag, owner] of Object.entries(FAMILY_ONLY_ARGS)) {
    if (flags.has(flag) && family !== owner) {
      throw new Error(`resource run refused: ${flag} belongs to family '${owner}', not '${family}'`);
    }
  }
  if (family === "discover" && !(flags.get("--input") ?? []).some((value) => value.length > 0)) {
    throw new Error("resource run refused: discover requires --input <json-file>");
  }
  if (family === "crawl") {
    if (source === undefined) throw new Error("resource run refused: crawl requires --source <source>");
    if (!(flags.get("--db") ?? []).some((value) => value.length > 0)) {
      throw new Error("resource run refused: crawl requires --db <sqlite-file>");
    }
  }
  if (family === "canon" && source !== undefined && source !== BITCOIN_CANON_SOURCE_ID) {
    throw new Error(`resource run refused: canon requires --source ${BITCOIN_CANON_SOURCE_ID}`);
  }
  if ((family === "places" || family === "pubky-posts") && source !== undefined && !pubkyPostsSelected) {
    throw new Error(`resource run refused: --source does not apply to family '${family}'`);
  }
  return family;
}
