import { randomBytes } from "node:crypto";
import type pg from "pg";
import type { Config } from "../config.js";
import { postJson } from "../http.js";
import { log } from "../log.js";
import { assertScoutUrl } from "./client.js";
import { ensureScoutSchemaCache, schemaHealthSnapshot, type SchemaHealth } from "./schema-cache.js";
import { scoutEnvelopeSchema, scoutErrorSchema } from "./types.js";

export type CanaryClass = "accepted" | "rejected" | "unknown";
export type CanaryOutcome = "pass" | "fail" | "unknown";

export interface ProbeResult {
  name: string;
  cypher: string;
  classification: CanaryClass;
  status: number | null;
  error?: string;
}

export interface CanaryRunResult {
  outcome: CanaryOutcome;
  probes: ProbeResult[];
  readCount: number | null;
  consecutiveUnknown: number;
  switchFlipped: boolean;
  durationMs: number;
}

export interface CanarySnapshot {
  lastOutcome: CanaryOutcome | null;
  lastAt: string | null;
  consecutiveUnknown: number;
  switchFlipped: boolean;
  lastAcceptedProbe: string | null;
  scoutSchema: SchemaHealth;
}

export function classifyWriteResponse(opts: {
  networkError: boolean;
  status: number;
  body: unknown;
}): CanaryClass {
  if (opts.networkError) return "unknown";
  if (opts.status <= 0 || opts.status >= 500) return "unknown";
  if (opts.status >= 400) return "rejected";
  if (opts.status >= 200 && opts.status < 300) {
    const err = scoutErrorSchema.safeParse(opts.body);
    if (err.success && err.data.error) return "rejected";
    return "accepted";
  }
  return "unknown";
}

export function writeProbes(nonce: string): Array<{ name: string; cypher: string; params: Record<string, unknown> }> {
  return [
    {
      name: "CREATE",
      cypher: "CREATE (n:JebCanary {nonce: $nonce}) RETURN n LIMIT 1",
      params: { nonce },
    },
    {
      name: "MERGE",
      cypher: "MERGE (n:JebCanary {nonce: $nonce}) RETURN n LIMIT 1",
      params: { nonce },
    },
    {
      name: "SET",
      cypher: "MATCH (n:JebCanary {nonce: $nonce}) SET n.x = 1 RETURN n LIMIT 1",
      params: { nonce },
    },
    {
      name: "DELETE",
      cypher: "MATCH (n:JebCanary {nonce: $nonce}) DELETE n RETURN count(n) AS c LIMIT 1",
      params: { nonce },
    },
    {
      name: "CALL dbms",
      cypher: "CALL dbms.listConfig() YIELD name RETURN name LIMIT 1",
      params: {},
    },
    {
      name: "LOAD CSV",
      cypher: "LOAD CSV FROM 'https://example.invalid/jeb-canary.csv' AS row RETURN row LIMIT 1",
      params: {},
    },
    {
      name: "APOC write",
      cypher: "CALL apoc.create.node(['JebCanary'], {nonce: $nonce}) YIELD node RETURN node LIMIT 1",
      params: { nonce },
    },
  ];
}

function rowCount(body: unknown): number | null {
  const parsed = scoutEnvelopeSchema.safeParse(body);
  if (!parsed.success) return null;
  const first = parsed.data.results[0];
  if (first && typeof first === "object" && first !== null) {
    const rec = first as Record<string, unknown>;
    const c = rec.c ?? rec.count;
    if (typeof c === "number" && Number.isFinite(c)) return c;
  }
  if (typeof parsed.data.count === "number") return parsed.data.count;
  return null;
}

export class ScoutWriteCanary {
  private consecutiveUnknown = 0;
  private last: Omit<CanarySnapshot, "scoutSchema"> = {
    lastOutcome: null,
    lastAt: null,
    consecutiveUnknown: 0,
    switchFlipped: false,
    lastAcceptedProbe: null,
  };

  constructor(
    private readonly cfg: Pick<
      Config,
      "scoutUrl" | "scoutTimeoutMs" | "scoutCanaryUnknownThreshold" | "scoutSchemaRefreshMs"
    >,
    private readonly pool: pg.Pool | undefined,
    private readonly flipScoutSwitch: () => Promise<void>,
  ) {
    ensureScoutSchemaCache(this.cfg);
  }

  snapshot(): CanarySnapshot {
    return { ...this.last, scoutSchema: schemaHealthSnapshot() };
  }

  async run(): Promise<CanaryRunResult> {
    const started = Date.now();
    const nonce = randomBytes(16).toString("hex");
    const probes: ProbeResult[] = [];
    let acceptedName: string | null = null;

    for (const p of writeProbes(nonce)) {
      const r = await this.post(p.cypher, p.params);
      probes.push({ name: p.name, cypher: p.cypher, classification: r.classification, status: r.status, error: r.error });
      if (r.classification === "accepted") acceptedName = p.name;
    }

    let readCount: number | null = null;
    const read = await this.post("MATCH (n:JebCanary) RETURN count(n) AS c LIMIT 1", {});
    let readClass: CanaryClass = "unknown";
    if (read.classification === "accepted") {
      readCount = rowCount(read.body);
      if (readCount === null) readClass = "unknown";
      else if (readCount > 0) {
        readClass = "accepted";
        if (acceptedName === null) acceptedName = "MATCH count";
      } else readClass = "rejected";
    } else if (read.classification === "rejected") {
      readClass = "unknown";
    } else {
      readClass = "unknown";
    }
    probes.push({
      name: "MATCH count",
      cypher: "MATCH (n:JebCanary) RETURN count(n) AS c LIMIT 1",
      classification: readClass,
      status: read.status,
      error: read.error,
    });

    const anyUnknown = probes.some((p) => p.classification === "unknown");
    const anyAccepted = acceptedName !== null;

    let outcome: CanaryOutcome;
    let switchFlipped = false;
    if (anyAccepted) {
      this.consecutiveUnknown = 0;
      outcome = "fail";
      log.error(
        { event: "scout_canary_fail", probe: acceptedName, probes },
        "Scout write canary accepted a write-shaped statement; flipping scout switch",
      );
      try {
        await this.flipScoutSwitch();
        switchFlipped = true;
      } catch (e) {
        log.error({ err: String(e) }, "failed to flip scout switch after canary acceptance");
      }
    } else if (anyUnknown) {
      this.consecutiveUnknown += 1;
      outcome = "unknown";
      if (this.consecutiveUnknown >= this.cfg.scoutCanaryUnknownThreshold) {
        log.error(
          { event: "scout_canary_unknown", n: this.consecutiveUnknown, probes },
          "Scout write canary consecutive unknowns above threshold",
        );
      } else {
        log.warn({ event: "scout_canary_unknown", n: this.consecutiveUnknown }, "Scout write canary unknown (network/5xx)");
      }
    } else {
      this.consecutiveUnknown = 0;
      outcome = "pass";
      log.info({ event: "scout_canary_pass", probes: probes.map((p) => p.name) }, "Scout write canary: all writes rejected");
    }

    const durationMs = Date.now() - started;
    this.last = {
      lastOutcome: outcome,
      lastAt: new Date().toISOString(),
      consecutiveUnknown: this.consecutiveUnknown,
      switchFlipped,
      lastAcceptedProbe: acceptedName,
    };
    await this.record({
      outcome,
      acceptedProbe: acceptedName,
      consecutiveUnknown: this.consecutiveUnknown,
      switchFlipped,
      detail: probes,
      durationMs,
    });
    return { outcome, probes, readCount, consecutiveUnknown: this.consecutiveUnknown, switchFlipped, durationMs };
  }

  private async post(
    cypher: string,
    params: Record<string, unknown>,
  ): Promise<{ classification: CanaryClass; status: number | null; body: unknown; error?: string }> {
    try {
      const origin = new URL(this.cfg.scoutUrl);
      const url = new URL("/v1/query", origin.origin.endsWith("/") ? origin.origin : `${origin.origin}/`);
      assertScoutUrl(url, origin.host);
      const res = await postJson(url, this.cfg.scoutTimeoutMs, { cypher, params, limit: 1 });
      const classification = classifyWriteResponse({ networkError: false, status: res.status, body: res.body });
      return { classification, status: res.status, body: res.body };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { classification: "unknown", status: null, body: null, error: msg };
    }
  }

  private async record(row: {
    outcome: CanaryOutcome;
    acceptedProbe: string | null;
    consecutiveUnknown: number;
    switchFlipped: boolean;
    detail: ProbeResult[];
    durationMs: number;
  }): Promise<void> {
    if (!this.pool) return;
    try {
      await this.pool.query(
        `INSERT INTO scout_canary (outcome, accepted_probe, consecutive_unknown, switch_flipped, detail, duration_ms)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
        [
          row.outcome,
          row.acceptedProbe,
          row.consecutiveUnknown,
          row.switchFlipped,
          JSON.stringify(row.detail),
          row.durationMs,
        ],
      );
    } catch (e) {
      log.warn({ err: String(e) }, "scout_canary insert failed");
    }
  }
}

export async function runScoutCanaryOnce(
  cfg: Config,
  pool: pg.Pool | undefined,
  flipScoutSwitch: () => Promise<void>,
): Promise<CanaryRunResult> {
  const canary = new ScoutWriteCanary(cfg, pool, flipScoutSwitch);
  return canary.run();
}
