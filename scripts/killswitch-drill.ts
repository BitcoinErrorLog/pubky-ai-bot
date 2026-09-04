#!/usr/bin/env node
/**
 * Kill-switch drill (Stage 1 gate: "kill switch drill passed in production",
 * "Global switch disables all write paths within one minute").
 *
 * For each switch in [global, replies, generation, consumption, scout, web]:
 *   1. record the baseline switch state (switches table + kill_switch),
 *   2. flip the switch ON via the same helper the admin endpoint uses
 *      (Store.setSwitch → Postgres switches table),
 *   3. poll the switch-specific observable and assert the effect within
 *      --deadline-ms (default 60 s),
 *   4. restore the baseline and assert recovery within the same deadline,
 *   5. print per-switch time-to-effect / time-to-recover.
 *
 * Observables (whatever the running code already exposes):
 *   global / replies  — publisher refuses the probe publish_requests row:
 *                       last_error becomes "Error: replies switch on".
 *   generation        — reason stops claiming work_queue rows: the probe row
 *                       stays 'queued' for the whole suppression window
 *                       (--suppress-ms); a claim while ON is a violation.
 *   consumption       — ingest /healthz lastPollAgeMs goes stale
 *                       (--poll-stale-ms) because polling is paused.
 *   scout / web       — the real tool executors (createScoutTools /
 *                       createSearchWebTool), wired to the live switches
 *                       table, return the SWITCH refusal.
 *
 * All switches are restored to baseline on exit, including SIGINT and
 * uncaught errors. Exit code is non-zero when any switch misses a deadline.
 *
 * Local:  DATABASE_URL=postgres://…@127.0.0.1:5432/jeb npm run drill:killswitch -- --health-port 9000
 * Prod:   railway ssh --service jeb -- node dist/scripts/killswitch-drill.js --target railway --health-url http://127.0.0.1:$JEB_PORT/healthz
 *         (see docs/killswitch-drill.md; never run --target railway from a drill branch)
 */
import { pathToFileURL } from "node:url";
import { Store } from "../src/db.js";
import { log } from "../src/log.js";
import type { Config } from "../src/config.js";
import { configFromProcessEnv } from "../src/config.js";
import { ALL_SWITCHES } from "../src/switches.js";
import { createScoutTools } from "../src/scout/tools.js";
import { createSearchWebTool } from "../src/web/tools.js";

export const DRILL_SWITCHES = ["global", "replies", "generation", "consumption", "scout", "web"] as const;
export type DrillSwitchName = (typeof DRILL_SWITCHES)[number];

export const DEFAULT_DEADLINE_MS = 60_000;
export const DEFAULT_INTERVAL_MS = 250;
export const DEFAULT_SUPPRESS_MS = 10_000;
export const DEFAULT_POLL_STALE_MS = 10_000;

export class DrillTimeoutError extends Error {}
export class ProbeViolationError extends Error {}
export class BaselineError extends Error {}

/* ---------------------------------------------------------------- clock */

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/** Deterministic clock for tests: sleep advances time instantly. */
export class FakeClock implements Clock {
  constructor(private t = 0) {}
  now(): number {
    return this.t;
  }
  sleep(ms: number): Promise<void> {
    this.t += ms;
    return Promise.resolve();
  }
}

/* ------------------------------------------------------- switch control */

export interface SwitchSnapshot {
  /** Every row of the switches table at baseline (missing row = off). */
  switches: Record<string, boolean>;
  killSwitch: boolean;
}

export interface SwitchController {
  snapshot(): Promise<SwitchSnapshot>;
  set(name: DrillSwitchName, on: boolean): Promise<void>;
  restore(snapshot: SwitchSnapshot): Promise<void>;
}

/**
 * Restores are exact: `global` first (it rewrites every switch row and the
 * kill_switch row), then each named switch, then kill_switch itself —
 * setSwitch(consumption|generation|replies, true) also sets kill_switch and
 * only this final UPDATE clears it again.
 */
export class DbSwitchController implements SwitchController {
  constructor(private readonly store: Store) {}

  async snapshot(): Promise<SwitchSnapshot> {
    const r = await this.store.pool.query<{ name: string; on_flag: boolean }>(
      "SELECT name, on_flag FROM switches",
    );
    const switches: Record<string, boolean> = {};
    for (const row of r.rows) switches[row.name] = row.on_flag === true;
    return { switches, killSwitch: await this.store.killSwitchOn() };
  }

  async set(name: DrillSwitchName, on: boolean): Promise<void> {
    await this.store.setSwitch(name, on);
  }

  async restore(snapshot: SwitchSnapshot): Promise<void> {
    // Global first even when its row was absent at baseline (absent = off):
    // setSwitch("global", …) rewrites every switch row and kill_switch.
    await this.store.setSwitch("global", snapshot.switches["global"] === true);
    for (const n of ALL_SWITCHES) {
      if (n in snapshot.switches) {
        await this.store.setSwitch(n, snapshot.switches[n] === true);
      } else {
        await this.store.setSwitch(n, false);
      }
    }
    await this.store.pool.query("UPDATE kill_switch SET disabled = $1 WHERE id = 1", [
      snapshot.killSwitch,
    ]);
  }
}

/** Refuse to drill when anything is already off-nominal. */
export function assertBaselineClean(snapshot: SwitchSnapshot): void {
  const on = Object.entries(snapshot.switches)
    .filter(([, v]) => v)
    .map(([k]) => k);
  if (snapshot.killSwitch) on.push("kill_switch");
  if (on.length > 0) {
    throw new BaselineError(
      `switches already on at baseline: ${on.join(", ")} — resolve before drilling (the drill would mask the cause)`,
    );
  }
}

/* ---------------------------------------------------------------- probes */

/** Minimal query surface the probes need (pg.Pool is structurally compatible). */
export interface Querier {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface Probe {
  /**
   * Baseline health check, polled before the switch is flipped. Must become
   * true within the deadline or the drill aborts with BaselineError. Polled
   * (not one-shot) because a previous switch's test also pauses neighbouring
   * pipelines via kill_switch — the baseline needs a moment to recover.
   */
  preflight?(): Promise<boolean>;
  /** Create fresh probe artifacts. Runs after the switch is ON. */
  arm(): Promise<void>;
  /**
   * Positive signal that the switch took effect. Must throw
   * ProbeViolationError on counter-evidence (action happened while ON).
   */
  effect(): Promise<boolean>;
  /** Signal that the pipeline resumed after the baseline was restored. */
  recovered(): Promise<boolean>;
  /** Remove probe artifacts. Best-effort; runs even on failure. */
  cleanup(): Promise<void>;
}

const DRILL_SUBJECT_PK = "a".repeat(52);

/** Synthetic, valid pubky post URI for probe rows (never published to by us). */
export function drillPostUri(label: string, seq: number): string {
  const base = `${label}${seq}`.toLowerCase().replace(/[^a-z0-9]/g, "0");
  const author = base.padEnd(52, "0").slice(0, 52);
  const id = `DRILL${label}${seq}`
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "0")
    .padEnd(13, "0")
    .slice(0, 13);
  return `pubky://${author}/pub/pubky.app/posts/${id}`;
}

/**
 * Publisher write path (replies + global). Arms a queued publish_requests
 * row; the running publisher claims it, refuses the PUT while the switch is
 * on (last_error "Error: replies switch on"), and publishes it after restore.
 */
export class PublishRefusalProbe implements Probe {
  protected key: string | null = null;

  constructor(
    protected readonly db: Querier,
    private readonly label: string,
    private readonly seq: number = Date.now() % 1_000_000,
  ) {}

  async arm(): Promise<void> {
    const key = drillPostUri(this.label, this.seq);
    this.key = key;
    await this.db.query(
      `INSERT INTO handled_mentions (mention_key, status, author, bot_id)
       VALUES ($1, 'processing', $2, 'drill')
       ON CONFLICT (mention_key) DO NOTHING`,
      [key, key.slice("pubky://".length, "pubky://".length + 52)],
    );
    await this.db.query(
      `INSERT INTO publish_requests (mention_key, parent_uri, content, evidence_id, categories)
       VALUES ($1, $1, $2, NULL, '[]'::jsonb)`,
      [key, "kill-switch drill probe (safe to delete)"],
    );
  }

  private async row(): Promise<{ status: string; last_error: string | null }> {
    if (!this.key) throw new ProbeViolationError("probe not armed");
    const r = await this.db.query("SELECT status, last_error FROM publish_requests WHERE mention_key = $1", [
      this.key,
    ]);
    const row = r.rows[0] as { status?: unknown; last_error?: unknown } | undefined;
    if (!row) throw new ProbeViolationError("probe publish_requests row vanished");
    return { status: String(row.status), last_error: typeof row.last_error === "string" ? row.last_error : null };
  }

  async effect(): Promise<boolean> {
    const row = await this.row();
    return row.last_error !== null && row.last_error.includes("replies switch on");
  }

  async recovered(): Promise<boolean> {
    const row = await this.row();
    return row.status === "published";
  }

  async cleanup(): Promise<void> {
    if (!this.key) return;
    await this.db.query("DELETE FROM publish_requests WHERE mention_key = $1", [this.key]);
    await this.db.query("DELETE FROM handled_mentions WHERE mention_key = $1", [this.key]);
    this.key = null;
  }
}

/**
 * Reason work path (generation). No positive "refused" marker exists in the
 * schema, so the effect is suppression: the armed work_queue row must remain
 * 'queued', sampled every poll interval, for the whole --suppress-ms window.
 * A claim while the switch is on is counter-evidence and fails immediately.
 */
export class WorkSuppressionProbe implements Probe {
  protected key: string | null = null;
  private armedAt = 0;

  constructor(
    protected readonly db: Querier,
    private readonly clock: Clock,
    private readonly suppressMs: number,
    private readonly seq: number = Date.now() % 1_000_000,
  ) {}

  async arm(): Promise<void> {
    const key = drillPostUri("generation", this.seq);
    this.key = key;
    this.armedAt = this.clock.now();
    await this.db.query(
      `INSERT INTO handled_mentions (mention_key, status, author, bot_id)
       VALUES ($1, 'processing', $2, 'drill')
       ON CONFLICT (mention_key) DO NOTHING`,
      [key, key.slice("pubky://".length, "pubky://".length + 52)],
    );
    await this.db.query(
      `INSERT INTO work_queue (mention_key, author, kind, payload, status)
       VALUES ($1, $2, 'mention', $3::jsonb, 'queued')`,
      [key, key.slice("pubky://".length, "pubky://".length + 52), JSON.stringify({ mentionKey: key })],
    );
  }

  private async status(): Promise<string> {
    if (!this.key) throw new ProbeViolationError("probe not armed");
    const r = await this.db.query("SELECT status FROM work_queue WHERE mention_key = $1", [this.key]);
    const row = r.rows[0] as { status?: unknown } | undefined;
    if (!row) throw new ProbeViolationError("probe work_queue row vanished");
    return String(row.status);
  }

  async effect(): Promise<boolean> {
    const status = await this.status();
    if (status !== "queued") {
      throw new ProbeViolationError(`work claimed while generation switch on (status=${status})`);
    }
    return this.clock.now() - this.armedAt >= this.suppressMs;
  }

  async recovered(): Promise<boolean> {
    return (await this.status()) !== "queued";
  }

  async cleanup(): Promise<void> {
    if (!this.key) return;
    await this.db.query("DELETE FROM work_queue WHERE mention_key = $1", [this.key]);
    await this.db.query("DELETE FROM handled_mentions WHERE mention_key = $1", [this.key]);
    this.key = null;
  }
}

export type FetchFn = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * Ingest poll path (consumption). ingest /healthz exposes lastPollAgeMs,
 * which only advances when a Nexus poll completes; with the switch on the
 * poll loop short-circuits before the fetch, so the age goes stale.
 */
export class IngestHealthProbe implements Probe {
  constructor(
    private readonly healthUrl: string,
    private readonly staleMs: number,
    private readonly fetchFn: FetchFn = defaultFetch,
  ) {}

  private async lastPollAgeMs(): Promise<number | null> {
    const res = await this.fetchFn(this.healthUrl);
    if (!res.ok) throw new Error(`ingest health returned ${res.status}`);
    const body = (await res.json()) as { lastPollAgeMs?: number | null };
    return typeof body.lastPollAgeMs === "number" ? body.lastPollAgeMs : null;
  }

  async preflight(): Promise<boolean> {
    const age = await this.lastPollAgeMs();
    return age !== null && age < this.staleMs;
  }

  async effect(): Promise<boolean> {
    const age = await this.lastPollAgeMs();
    return age === null || age >= this.staleMs;
  }

  async recovered(): Promise<boolean> {
    const age = await this.lastPollAgeMs();
    return age !== null && age < this.staleMs / 2;
  }

  async arm(): Promise<void> {}
  async cleanup(): Promise<void> {}
}

const defaultFetch: FetchFn = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  return { ok: res.ok, status: res.status, json: () => res.json() as Promise<unknown> };
};

/** Reads the refusal code out of a tool result (`{error: "SWITCH", …}`). */
export function outcomeError(out: unknown): string | null {
  if (out && typeof out === "object" && "error" in out) {
    const e = (out as { error: unknown }).error;
    return typeof e === "string" ? e : null;
  }
  return null;
}

/**
 * Scout tool path. Drives the real recommend_follows executor with
 * storeSwitchOn wired to the live switches table — the same code the reason
 * process runs inside its tool loop. cfg.scoutUrl is forced to a closed
 * loopback port so the recovery phase never touches the real scout service;
 * any outcome other than a SWITCH refusal proves the gate opened again.
 */
export class ScoutToolProbe implements Probe {
  private readonly tools: ReturnType<typeof createScoutTools>;

  constructor(store: Store, cfg: Config) {
    this.tools = createScoutTools({
      cfg,
      pool: store.pool,
      mentionKey: drillPostUri("scout", Date.now() % 1_000_000),
      storeSwitchOn: () => store.switchOn("scout"),
    });
  }

  private async call(): Promise<unknown> {
    try {
      return await this.tools.recommend_follows.execute({ pubky: DRILL_SUBJECT_PK });
    } catch (e) {
      // The SWITCH refusal is returned, never thrown — a throw means the gate
      // was passed and the (deliberately unreachable) upstream failed.
      return { thrown: String(e) };
    }
  }

  async effect(): Promise<boolean> {
    return outcomeError(await this.call()) === "SWITCH";
  }

  async recovered(): Promise<boolean> {
    return outcomeError(await this.call()) !== "SWITCH";
  }

  async arm(): Promise<void> {}
  async cleanup(): Promise<void> {}
}

/**
 * Web tool path. Same pattern as the scout probe; cfg.provider stays
 * "moonshot" (the "off" provider refuses before the switch gate, which would
 * mask the test) with the base URL forced to a closed loopback port.
 */
export class WebToolProbe implements Probe {
  private readonly tool: ReturnType<typeof createSearchWebTool>;

  constructor(store: Store, cfg: Config) {
    this.tool = createSearchWebTool({
      cfg,
      pool: store.pool,
      mentionKey: drillPostUri("web", Date.now() % 1_000_000),
      storeSwitchOn: () => store.switchOn("web"),
    });
  }

  private async call(): Promise<unknown> {
    try {
      return await this.tool.execute({ query: "pubky killswitch drill probe" });
    } catch (e) {
      return { thrown: String(e) };
    }
  }

  async effect(): Promise<boolean> {
    return outcomeError(await this.call()) === "SWITCH";
  }

  async recovered(): Promise<boolean> {
    return outcomeError(await this.call()) !== "SWITCH";
  }

  async arm(): Promise<void> {}
  async cleanup(): Promise<void> {}
}

/* ---------------------------------------------------------------- engine */

export interface DrillOptions {
  controller: SwitchController;
  probes: Partial<Record<DrillSwitchName, Probe>>;
  clock: Clock;
  deadlineMs: number;
  intervalMs: number;
}

export interface DrillResult {
  switch: DrillSwitchName;
  ok: boolean;
  effectMs: number | null;
  recoverMs: number | null;
  error: string | null;
}

/** Poll `check` until true; returns elapsed ms. Throws DrillTimeoutError past the deadline. */
export async function waitFor(
  check: () => Promise<boolean>,
  clock: Clock,
  deadlineMs: number,
  intervalMs: number,
): Promise<number> {
  const start = clock.now();
  for (;;) {
    if (await check()) return clock.now() - start;
    if (clock.now() - start >= deadlineMs) {
      throw new DrillTimeoutError(`not observed within ${deadlineMs} ms deadline`);
    }
    await clock.sleep(intervalMs);
  }
}

export async function drillOne(
  name: DrillSwitchName,
  opts: DrillOptions,
  snapshot: SwitchSnapshot,
  onProgress: (msg: string) => void = () => {},
): Promise<DrillResult> {
  const probe = opts.probes[name];
  if (!probe) throw new Error(`no probe built for switch ${name}`);
  const result: DrillResult = { switch: name, ok: false, effectMs: null, recoverMs: null, error: null };
  let armed = false;
  try {
    if (probe.preflight) {
      onProgress(`${name}: waiting for a healthy baseline`);
      try {
        await waitFor(() => probe.preflight!(), opts.clock, opts.deadlineMs, opts.intervalMs);
      } catch {
        throw new BaselineError(
          `${name}: baseline never became healthy within ${opts.deadlineMs} ms (is the pipeline running?)`,
        );
      }
    }
    onProgress(`${name}: switch ON`);
    await opts.controller.set(name, true);
    await probe.arm();
    armed = true;
    result.effectMs = await waitFor(() => probe.effect(), opts.clock, opts.deadlineMs, opts.intervalMs);
    onProgress(`${name}: effect observed after ${result.effectMs} ms; restoring baseline`);
    await opts.controller.restore(snapshot);
    result.recoverMs = await waitFor(() => probe.recovered(), opts.clock, opts.deadlineMs, opts.intervalMs);
    onProgress(`${name}: recovered after ${result.recoverMs} ms`);
    result.ok = true;
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    onProgress(`${name}: FAIL — ${result.error}`);
    try {
      await opts.controller.restore(snapshot);
    } catch (restoreErr) {
      result.error += `; restore failed: ${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}`;
    }
  } finally {
    if (armed) {
      try {
        await probe.cleanup();
      } catch {
        /* best-effort */
      }
    }
  }
  return result;
}

/** Runs the full drill. Throws BaselineError before flipping anything. */
export async function executeDrill(
  names: DrillSwitchName[],
  opts: DrillOptions,
  snapshot: SwitchSnapshot,
  onProgress: (msg: string) => void = () => {},
): Promise<DrillResult[]> {
  assertBaselineClean(snapshot);
  const results: DrillResult[] = [];
  for (const name of names) {
    results.push(await drillOne(name, opts, snapshot, onProgress));
  }
  return results;
}

/* -------------------------------------------------------------- reporting */

export interface DrillMeta {
  target: string;
  deadlineMs: number;
  startedAt: string;
}

export function formatTable(results: DrillResult[], meta: DrillMeta): string {
  const lines: string[] = [];
  lines.push(`kill-switch drill  target=${meta.target}  deadline=${meta.deadlineMs} ms  started=${meta.startedAt}`);
  lines.push("");
  lines.push(`${"switch".padEnd(13)}${"time-to-effect".padStart(17)}${"time-to-recover".padStart(18)}${"result".padStart(9)}`);
  lines.push(`${"-".repeat(12)} ${"-".repeat(16)} ${"-".repeat(17)} ${"-".repeat(6)}`);
  for (const r of results) {
    const eff = r.effectMs === null ? "-" : `${r.effectMs} ms`;
    const rec = r.recoverMs === null ? "-" : `${r.recoverMs} ms`;
    lines.push(
      `${r.switch.padEnd(13)}${eff.padStart(17)}${rec.padStart(18)}${(r.ok ? "pass" : "FAIL").padStart(9)}`,
    );
  }
  const failed = results.filter((r) => !r.ok);
  for (const f of failed) lines.push(`error ${f.switch}: ${f.error ?? "unknown"}`);
  lines.push("");
  lines.push(
    failed.length === 0
      ? `drill PASSED (${results.length}/${results.length} switches within ${meta.deadlineMs} ms)`
      : `drill FAILED (${failed.length}/${results.length} switches missed the ${meta.deadlineMs} ms deadline)`,
  );
  return lines.join("\n");
}

export function buildJsonReport(results: DrillResult[], meta: DrillMeta): string {
  return JSON.stringify(
    {
      drill: "killswitch",
      target: meta.target,
      startedAt: meta.startedAt,
      deadlineMs: meta.deadlineMs,
      ok: results.every((r) => r.ok),
      results,
    },
    null,
    2,
  );
}

/* ------------------------------------------------------------------- CLI */

export interface CliArgs {
  only: DrillSwitchName[];
  json: boolean;
  target: "local" | "railway";
  deadlineMs: number;
  intervalMs: number;
  suppressMs: number;
  pollStaleMs: number;
  healthUrl: string | null;
  databaseUrl: string;
}

export function isDrillSwitch(s: string): s is DrillSwitchName {
  return (DRILL_SWITCHES as readonly string[]).includes(s);
}

function posInt(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${flag} expects a positive integer, got "${raw}"`);
  return n;
}

export const USAGE = `Usage: killswitch-drill [options]

Options:
  --only <switch>[,<switch>…]   drill only these switches (default: all of
                                ${DRILL_SWITCHES.join(", ")}); repeatable
  --json                        print the JSON report instead of the table
  --target <local|railway>      default local; "railway" lifts the loopback
                                DATABASE_URL guard (production drill only)
  --deadline-ms <n>             effect/recovery deadline per switch (default ${DEFAULT_DEADLINE_MS})
  --interval-ms <n>             observer poll interval (default ${DEFAULT_INTERVAL_MS})
  --suppress-ms <n>             generation suppression window (default ${DEFAULT_SUPPRESS_MS})
  --poll-stale-ms <n>           consumption: lastPollAgeMs threshold (default ${DEFAULT_POLL_STALE_MS})
  --health-url <url>            ingest /healthz URL (required for consumption)
  --health-port <port>          shorthand for http://127.0.0.1:<port>/healthz
  --help                        this text

Env: DATABASE_URL (required). Progress goes to stderr; the report to stdout.`;

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliArgs {
  const names: DrillSwitchName[] = [];
  let json = false;
  let target: "local" | "railway" = "local";
  let deadlineMs = DEFAULT_DEADLINE_MS;
  let intervalMs = DEFAULT_INTERVAL_MS;
  let suppressMs = DEFAULT_SUPPRESS_MS;
  let pollStaleMs = DEFAULT_POLL_STALE_MS;
  let healthUrl: string | null = null;

  const next = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined) throw new Error(`${flag} requires a value`);
    return v;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--only") {
      const v = next(i, a);
      i++;
      for (const part of v.split(",")) {
        const n = part.trim();
        if (!isDrillSwitch(n)) throw new Error(`unknown switch "${n}" (expected one of ${DRILL_SWITCHES.join(", ")})`);
        if (!names.includes(n)) names.push(n);
      }
    } else if (a === "--json") {
      json = true;
    } else if (a === "--target") {
      const v = next(i, a);
      i++;
      if (v !== "local" && v !== "railway") throw new Error(`--target expects local|railway, got "${v}"`);
      target = v;
    } else if (a === "--deadline-ms") {
      deadlineMs = posInt(next(i, a), a);
      i++;
    } else if (a === "--interval-ms") {
      intervalMs = posInt(next(i, a), a);
      i++;
    } else if (a === "--suppress-ms") {
      suppressMs = posInt(next(i, a), a);
      i++;
    } else if (a === "--poll-stale-ms") {
      pollStaleMs = posInt(next(i, a), a);
      i++;
    } else if (a === "--health-url") {
      healthUrl = next(i, a);
      i++;
    } else if (a === "--health-port") {
      healthUrl = `http://127.0.0.1:${posInt(next(i, a), a)}/healthz`;
      i++;
    } else if (a === "--help" || a === "-h") {
      throw new Error(USAGE);
    } else {
      throw new Error(`unknown flag "${a}"\n${USAGE}`);
    }
  }

  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  if (target !== "railway") {
    let host = "";
    try {
      host = new URL(databaseUrl).hostname;
    } catch {
      throw new Error("DATABASE_URL is not a parseable URL");
    }
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) {
      throw new Error(
        `refusing to drill against non-loopback database host "${host}" without an explicit --target railway`,
      );
    }
  }
  const only = names.length > 0 ? names : [...DRILL_SWITCHES];
  if (only.includes("consumption") && !healthUrl) {
    throw new Error("--health-url (or --health-port) is required when the consumption switch is drilled");
  }
  return { only, json, target, deadlineMs, intervalMs, suppressMs, pollStaleMs, healthUrl, databaseUrl };
}

/**
 * Config for the in-process tool probes. The upstreams are forced to a
 * closed loopback port so the recovery phase is deterministic and never
 * touches the real scout service or web provider; the switch gate is the
 * only thing under test.
 */
export function probeConfigs(): { scoutCfg: Config; webCfg: Config } {
  const base = configFromProcessEnv({ requireSecret: false });
  return {
    scoutCfg: { ...base, scoutEnabled: true, scoutUrl: "http://127.0.0.1:9/" },
    webCfg: {
      ...base,
      webProvider: "moonshot",
      modelBaseUrl: "http://127.0.0.1:9/",
      modelApiKey: undefined,
    },
  };
}

export function buildProbes(args: CliArgs, store: Store): Partial<Record<DrillSwitchName, Probe>> {
  const probes: Partial<Record<DrillSwitchName, Probe>> = {};
  const querier = store.pool as unknown as Querier;
  const clock = new SystemClock();
  for (const name of args.only) {
    if (name === "global") probes.global = new PublishRefusalProbe(querier, "global");
    else if (name === "replies") probes.replies = new PublishRefusalProbe(querier, "replies");
    else if (name === "generation")
      probes.generation = new WorkSuppressionProbe(querier, clock, args.suppressMs);
    else if (name === "consumption") {
      if (!args.healthUrl) throw new Error("consumption probe requires --health-url");
      probes.consumption = new IngestHealthProbe(args.healthUrl, args.pollStaleMs);
    } else if (name === "scout") probes.scout = new ScoutToolProbe(store, probeConfigs().scoutCfg);
    else if (name === "web") probes.web = new WebToolProbe(store, probeConfigs().webCfg);
  }
  return probes;
}

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 2;
    return;
  }
  // Tool executors log each call at info; keep stdout limited to the report.
  if (!process.env.JEB_LOG_LEVEL) log.level = "warn";
  const store = new Store(args.databaseUrl);
  const controller = new DbSwitchController(store);
  const clock = new SystemClock();
  const progress = (msg: string) => console.error(`[drill] ${msg}`);

  let snapshot: SwitchSnapshot | null = null;
  const restore = async () => {
    if (snapshot) await controller.restore(snapshot);
  };
  const onSignal = (sig: string) => {
    console.error(`\n[drill] ${sig} — restoring all switches to baseline`);
    void restore()
      .catch(() => {})
      .finally(() => {
        void store.close().finally(() => process.exit(2));
      });
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  const startedAt = new Date().toISOString();
  try {
    snapshot = await controller.snapshot();
    const probes = buildProbes(args, store);
    const results = await executeDrill(
      args.only,
      { controller, probes, clock, deadlineMs: args.deadlineMs, intervalMs: args.intervalMs },
      snapshot,
      progress,
    );
    const meta: DrillMeta = { target: args.target, deadlineMs: args.deadlineMs, startedAt };
    console.log(args.json ? buildJsonReport(results, meta) : formatTable(results, meta));
    if (!results.every((r) => r.ok)) process.exitCode = 1;
  } catch (e) {
    console.error(`[drill] aborted: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  } finally {
    // Final safety net: every exit path leaves the switches at baseline.
    await restore().catch((e: unknown) => console.error(`[drill] WARNING: restore failed: ${String(e)}`));
    await store.close();
  }
}

const invokedAs = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedAs) {
  void main();
}
