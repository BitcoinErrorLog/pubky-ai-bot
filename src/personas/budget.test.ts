import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Store } from "../db.js";
import type { PersonaLedgerIdentity } from "../bot-kit/policy/persona-ledger.js";
import { reserveWebCall, finalizeWebCall } from "../bot-kit/web/budget.js";
import { releaseScoutCall, reserveScoutCall } from "../bot-kit/scout/budget.js";
import {
  cleanStaleVisualReservations,
  releaseTextTokens,
  reserveTextTokens,
  reserveVisualTokens,
  settleTextTokens,
  settleVisualTokens,
  type TokenLedgerPersona,
} from "../visual-token-reservation.js";
import { createProbePersona, currentPersonaIdentity, deleteProbePersona } from "../../tests/helpers/probe-persona.js";

const PREFIX = "persona-ledger-test:";
const PROBE_ID = "budget-probe";
const UTC_DAY_START = "(date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')";
const LARGE = 1_000_000_000;

let store: Store;
let jeb: PersonaLedgerIdentity;
let probe: PersonaLedgerIdentity;

async function deleteLedgerRows(): Promise<void> {
  await store.pool.query("DELETE FROM token_usage WHERE mention_key LIKE $1", [`${PREFIX}%`]);
  await store.pool.query("DELETE FROM web_queries WHERE mention_key LIKE $1", [`${PREFIX}%`]);
  await store.pool.query("DELETE FROM scout_queries WHERE mention_key LIKE $1", [`${PREFIX}%`]);
}

async function tokenBaseline(): Promise<number> {
  const result = await store.pool.query<{ total: string }>(
    `SELECT COALESCE(SUM(total_tokens), 0)::text AS total FROM token_usage WHERE created_at >= ${UTC_DAY_START}`,
  );
  return Number(result.rows[0]!.total);
}

async function webBaseline(): Promise<number> {
  const result = await store.pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM web_queries
     WHERE created_at >= date_trunc('day', now()) AND (ok = TRUE OR provider LIKE '%:reserved')`,
  );
  return Number(result.rows[0]!.n);
}

async function scoutBaseline(): Promise<number> {
  const result = await store.pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM scout_queries
     WHERE created_at >= ${UTC_DAY_START} AND (ok = TRUE OR error_code = 'CALL_RESERVED')`,
  );
  return Number(result.rows[0]!.n);
}

function tokenPersona(identity: PersonaLedgerIdentity, overrides: Partial<Omit<TokenLedgerPersona, "identity">> = {}): TokenLedgerPersona {
  return {
    identity,
    dailyTokens: LARGE,
    userDailyTokens: LARGE,
    imageDailyTokens: LARGE,
    ...overrides,
  };
}

type TokenAttempt = {
  mentionKey: string;
  publicKey: string;
  tokens: number;
  persona?: TokenLedgerPersona;
  image?: boolean;
};

async function raceTokens(attempts: TokenAttempt[], globalCeiling: number, userCeiling: number) {
  return Promise.all(attempts.map(async (attempt) => {
    const args = {
      mentionKey: attempt.mentionKey,
      publicKey: attempt.publicKey,
      targetTokens: attempt.tokens,
      globalCeiling,
      userCeiling,
      staleAfterMs: 300_000,
      persona: attempt.persona,
    };
    const reservation = attempt.image
      ? await reserveVisualTokens(store.pool, args)
      : await reserveTextTokens(store.pool, args);
    return { attempt, reservation };
  }));
}

type LedgerRow = { mention_key: string; public_key: string; persona_id: string; total_tokens: number; phase: string };

async function testTokenRows(): Promise<LedgerRow[]> {
  const result = await store.pool.query<LedgerRow>(
    `SELECT mention_key, public_key, persona_id, total_tokens, phase
       FROM token_usage WHERE mention_key LIKE $1 ORDER BY id`,
    [`${PREFIX}%`],
  );
  return result.rows;
}

function sum(rows: LedgerRow[], keep: (row: LedgerRow) => boolean = () => true): number {
  return rows.filter(keep).reduce((total, row) => total + Number(row.total_tokens), 0);
}

beforeAll(async () => {
  store = new Store(process.env.DATABASE_URL!);
  await store.migrate();
  await deleteLedgerRows();
  probe = await createProbePersona(store.pool, PROBE_ID);
  jeb = await currentPersonaIdentity(store.pool, "jeb");
});

afterEach(deleteLedgerRows);

afterAll(async () => {
  await deleteLedgerRows();
  await deleteProbePersona(store.pool, PROBE_ID);
  await store.close();
});

describe("atomic token admission across fleet and persona layers", () => {
  it("never admits past the persona daily ceiling when many users race", async () => {
    const baseline = await tokenBaseline();
    const persona = tokenPersona(probe, { dailyTokens: 100 });
    const results = await raceTokens(
      Array.from({ length: 12 }, (_, i) => ({
        mentionKey: `${PREFIX}persona-daily-${i}`,
        publicKey: `persona-daily-user-${i % 4}`,
        tokens: 30,
        persona,
      })),
      baseline + LARGE,
      LARGE,
    );
    const admitted = results.filter((r) => r.reservation);
    expect(admitted).toHaveLength(3);
    const rows = await testTokenRows();
    expect(rows).toHaveLength(admitted.length);
    expect(sum(rows, (row) => row.persona_id === PROBE_ID)).toBe(90);
    expect(rows.every((row) => row.phase === "token_reserve")).toBe(true);
  });

  it("enforces the persona-user ceiling per user without blocking other users", async () => {
    const baseline = await tokenBaseline();
    const persona = tokenPersona(probe, { userDailyTokens: 60 });
    const attempts: TokenAttempt[] = [
      ...Array.from({ length: 8 }, (_, i) => ({
        mentionKey: `${PREFIX}persona-user-hot-${i}`,
        publicKey: "persona-user-hot",
        tokens: 25,
        persona,
      })),
      { mentionKey: `${PREFIX}persona-user-cold`, publicKey: "persona-user-cold", tokens: 25, persona },
    ];
    const results = await raceTokens(attempts, baseline + LARGE, LARGE);
    const hot = results.filter((r) => r.attempt.publicKey === "persona-user-hot" && r.reservation);
    const cold = results.filter((r) => r.attempt.publicKey === "persona-user-cold" && r.reservation);
    expect(hot).toHaveLength(2);
    expect(cold).toHaveLength(1);
    const rows = await testTokenRows();
    expect(sum(rows, (row) => row.public_key === "persona-user-hot")).toBe(50);
    expect(rows).toHaveLength(3);
  });

  it("enforces the fleet daily ceiling across personas independently of persona ceilings", async () => {
    const baseline = await tokenBaseline();
    const results = await raceTokens(
      Array.from({ length: 10 }, (_, i) => ({
        mentionKey: `${PREFIX}fleet-daily-${i}`,
        publicKey: `fleet-daily-user-${i}`,
        tokens: 40,
        persona: tokenPersona(i % 2 === 0 ? jeb : probe),
      })),
      baseline + 100,
      LARGE,
    );
    expect(results.filter((r) => r.reservation)).toHaveLength(2);
    const rows = await testTokenRows();
    expect(rows).toHaveLength(2);
    expect(sum(rows)).toBe(80);
  });

  it("enforces the fleet-user ceiling across personas for one user", async () => {
    const baseline = await tokenBaseline();
    const results = await raceTokens(
      Array.from({ length: 8 }, (_, i) => ({
        mentionKey: `${PREFIX}fleet-user-${i}`,
        publicKey: "fleet-user-shared",
        tokens: 20,
        persona: tokenPersona(i % 2 === 0 ? jeb : probe),
      })),
      baseline + LARGE,
      50,
    );
    expect(results.filter((r) => r.reservation)).toHaveLength(2);
    expect(sum(await testTokenRows())).toBe(40);
  });

  it("keeps an exhausted persona from consuming or blocking another persona", async () => {
    const baseline = await tokenBaseline();
    const results = await raceTokens(
      Array.from({ length: 8 }, (_, i) => ({
        mentionKey: `${PREFIX}isolation-${i}`,
        publicKey: `isolation-user-${i}`,
        tokens: 30,
        persona: i % 2 === 0 ? tokenPersona(probe, { dailyTokens: 30 }) : tokenPersona(jeb),
      })),
      baseline + LARGE,
      LARGE,
    );
    const rows = await testTokenRows();
    expect(rows.filter((row) => row.persona_id === PROBE_ID)).toHaveLength(1);
    expect(rows.filter((row) => row.persona_id === "jeb")).toHaveLength(4);
    expect(results.filter((r) => r.reservation)).toHaveLength(5);
  });

  it("races every layer at once and leaves no partial rows for refusals", async () => {
    const baseline = await tokenBaseline();
    const fleetCeiling = 400;
    const fleetUserCeiling = 120;
    const probeLimits = { dailyTokens: 150, userDailyTokens: 70, imageDailyTokens: 60 };
    const attempts: TokenAttempt[] = Array.from({ length: 36 }, (_, i) => ({
      mentionKey: `${PREFIX}all-layers-${i}`,
      publicKey: `all-layers-user-${i % 3}`,
      tokens: 10 + (i % 4) * 5,
      persona: i % 3 === 0 ? tokenPersona(jeb) : tokenPersona(probe, probeLimits),
      image: i % 5 === 0,
    }));
    const results = await raceTokens(attempts, baseline + fleetCeiling, fleetUserCeiling);
    const rows = await testTokenRows();
    const admittedKeys = new Set(results.filter((r) => r.reservation).map((r) => r.attempt.mentionKey));
    expect(new Set(rows.map((row) => row.mention_key))).toEqual(admittedKeys);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(attempts.length);
    expect(sum(rows)).toBeLessThanOrEqual(fleetCeiling);
    for (const user of ["all-layers-user-0", "all-layers-user-1", "all-layers-user-2"]) {
      expect(sum(rows, (row) => row.public_key === user)).toBeLessThanOrEqual(fleetUserCeiling);
      expect(sum(rows, (row) => row.public_key === user && row.persona_id === PROBE_ID))
        .toBeLessThanOrEqual(probeLimits.userDailyTokens);
    }
    expect(sum(rows, (row) => row.persona_id === PROBE_ID)).toBeLessThanOrEqual(probeLimits.dailyTokens);
    expect(sum(rows, (row) => row.persona_id === PROBE_ID && row.phase === "image_reserve"))
      .toBeLessThanOrEqual(probeLimits.imageDailyTokens);
  });

  it("counts image calls against the persona image ceiling and text calls only against tokens", async () => {
    const baseline = await tokenBaseline();
    const persona = tokenPersona(probe, { imageDailyTokens: 50 });
    const results = await raceTokens(
      [
        ...Array.from({ length: 6 }, (_, i) => ({
          mentionKey: `${PREFIX}image-${i}`,
          publicKey: `image-user-${i}`,
          tokens: 20,
          persona,
          image: true,
        })),
        ...Array.from({ length: 4 }, (_, i) => ({
          mentionKey: `${PREFIX}image-text-${i}`,
          publicKey: `image-text-user-${i}`,
          tokens: 20,
          persona,
        })),
      ],
      baseline + LARGE,
      LARGE,
    );
    expect(results.filter((r) => r.attempt.image && r.reservation)).toHaveLength(2);
    expect(results.filter((r) => !r.attempt.image && r.reservation)).toHaveLength(4);
    const rows = await testTokenRows();
    expect(sum(rows, (row) => row.phase === "image_reserve")).toBe(40);
  });

  it("resizes only within every layer and leaves the row unchanged on refusal", async () => {
    const baseline = await tokenBaseline();
    const persona = tokenPersona(probe, { dailyTokens: 100 });
    const args = {
      mentionKey: `${PREFIX}resize`,
      publicKey: "resize-user",
      globalCeiling: baseline + LARGE,
      userCeiling: LARGE,
      staleAfterMs: 300_000,
      persona,
    };
    const first = await reserveTextTokens(store.pool, { ...args, targetTokens: 40 });
    expect(first).not.toBeNull();
    const grown = await reserveTextTokens(store.pool, { ...args, targetTokens: 90, reservation: first! });
    expect(grown?.estimatedTokens).toBe(90);
    expect(await reserveTextTokens(store.pool, { ...args, targetTokens: 101, reservation: grown! })).toBeNull();
    expect(await reserveTextTokens(store.pool, {
      ...args,
      targetTokens: 95,
      reservation: grown!,
      persona: tokenPersona(jeb),
    })).toBeNull();
    const rows = await testTokenRows();
    expect(rows).toEqual([expect.objectContaining({ total_tokens: 90, persona_id: PROBE_ID, phase: "token_reserve" })]);
  });

  it("resizes against the reservation's own UTC day", async () => {
    const persona = tokenPersona(probe, { dailyTokens: 100 });
    const args = {
      mentionKey: `${PREFIX}utc-day`,
      publicKey: "utc-day-user",
      globalCeiling: LARGE,
      userCeiling: LARGE,
      staleAfterMs: 3 * 86_400_000,
      persona,
    };
    const reservation = await reserveTextTokens(store.pool, { ...args, targetTokens: 50 });
    await store.pool.query(
      "UPDATE token_usage SET created_at = now() - interval '1 day' WHERE id = $1",
      [reservation!.id],
    );
    await store.pool.query(
      `INSERT INTO token_usage (
         mention_key, public_key, phase, total_tokens,
         persona_id, persona_version, persona_manifest_hash, target_bot_pk
       ) VALUES ($1, 'utc-day-other', 'answer', 45, $2, $3, $4, $5)`,
      [`${PREFIX}utc-day-yesterday`, probe.id, probe.version, probe.manifestHash, probe.botPk],
    );
    await store.pool.query(
      "UPDATE token_usage SET created_at = now() - interval '1 day' WHERE mention_key = $1",
      [`${PREFIX}utc-day-yesterday`],
    );
    expect(await reserveTextTokens(store.pool, { ...args, targetTokens: 60, reservation: reservation! })).toBeNull();
    expect(await reserveTextTokens(store.pool, { ...args, mentionKey: `${PREFIX}utc-day-today`, targetTokens: 100 }))
      .not.toBeNull();
    const settled = await settleTextTokens(store.pool, reservation!, { phase: "intent", totalTokens: 30 });
    expect(settled).toBe(30);
    const row = await store.pool.query<{ phase: string; day_offset: number }>(
      `SELECT phase, (date_trunc('day', now() AT TIME ZONE 'UTC')::date
                      - date_trunc('day', created_at AT TIME ZONE 'UTC')::date)::int AS day_offset
         FROM token_usage WHERE id = $1`,
      [reservation!.id],
    );
    expect(row.rows[0]).toEqual({ phase: "intent", day_offset: 1 });
  });

  it("settles reported, zero, and unknown text usage and releases exactly once", async () => {
    const baseline = await tokenBaseline();
    const base = {
      publicKey: "settle-user",
      targetTokens: 70,
      globalCeiling: baseline + LARGE,
      userCeiling: LARGE,
      staleAfterMs: 300_000,
      persona: tokenPersona(probe),
    };
    const reported = await reserveTextTokens(store.pool, { ...base, mentionKey: `${PREFIX}settle-reported` });
    const zero = await reserveTextTokens(store.pool, { ...base, mentionKey: `${PREFIX}settle-zero` });
    const unknown = await reserveTextTokens(store.pool, { ...base, mentionKey: `${PREFIX}settle-unknown` });
    const released = await reserveTextTokens(store.pool, { ...base, mentionKey: `${PREFIX}settle-released` });
    const over = await reserveTextTokens(store.pool, { ...base, mentionKey: `${PREFIX}settle-over` });

    expect(await settleTextTokens(store.pool, reported!, { phase: "intent", totalTokens: 33 })).toBe(33);
    expect(await settleTextTokens(store.pool, reported!, { phase: "intent", totalTokens: 33 })).toBeNull();
    expect(await settleTextTokens(store.pool, zero!, { phase: "intent", totalTokens: 0 })).toBe(0);
    expect(await settleTextTokens(store.pool, unknown!, { phase: "intent", totalTokens: null })).toBe(70);
    expect(await releaseTextTokens(store.pool, released!)).toBe(true);
    expect(await releaseTextTokens(store.pool, released!)).toBe(false);
    await expect(settleTextTokens(store.pool, over!, { phase: "intent", totalTokens: 71 }))
      .rejects.toThrow("provider usage exceeded reserved hard upper bound");

    const rows = await testTokenRows();
    expect(rows.map((row) => [row.mention_key.slice(PREFIX.length), row.phase, row.total_tokens])).toEqual([
      ["settle-reported", "intent", 33],
      ["settle-zero", "intent", 0],
      ["settle-unknown", "intent", 70],
      ["settle-over", "token_usage_invariant", 70],
    ]);
  });

  it("expires stale text reservations as conservative usage but refunds stale image reservations", async () => {
    const baseline = await tokenBaseline();
    const base = {
      publicKey: "stale-user",
      targetTokens: 40,
      globalCeiling: baseline + LARGE,
      userCeiling: LARGE,
      staleAfterMs: 300_000,
      persona: tokenPersona(probe, { dailyTokens: 100 }),
    };
    const text = await reserveTextTokens(store.pool, { ...base, mentionKey: `${PREFIX}stale-text` });
    const image = await reserveVisualTokens(store.pool, { ...base, mentionKey: `${PREFIX}stale-image` });
    await store.pool.query(
      "UPDATE token_usage SET created_at = now() - interval '10 minutes' WHERE id = ANY($1::bigint[])",
      [[text!.id, image!.id]],
    );
    expect(await cleanStaleVisualReservations(store.pool, 300_000)).toBeGreaterThanOrEqual(2);
    const rows = await testTokenRows();
    expect(rows).toEqual([expect.objectContaining({ mention_key: `${PREFIX}stale-text`, phase: "token_reserve_expired" })]);
    expect(await settleTextTokens(store.pool, text!, { phase: "intent", totalTokens: 1 })).toBeNull();
    expect(await reserveTextTokens(store.pool, { ...base, mentionKey: `${PREFIX}stale-next`, targetTokens: 61 })).toBeNull();
    expect(await reserveTextTokens(store.pool, { ...base, mentionKey: `${PREFIX}stale-next`, targetTokens: 60 })).not.toBeNull();
  });

  it("settles image calls conservatively on the same row for every layer", async () => {
    const baseline = await tokenBaseline();
    const reservation = await reserveVisualTokens(store.pool, {
      mentionKey: `${PREFIX}image-settle`,
      publicKey: "image-settle-user",
      targetTokens: 80,
      globalCeiling: baseline + LARGE,
      userCeiling: LARGE,
      staleAfterMs: 300_000,
      persona: tokenPersona(probe, { imageDailyTokens: 100 }),
    });
    expect(await settleVisualTokens(store.pool, reservation!, { phase: "intent_image", totalTokens: null })).toBe(80);
    const rows = await store.pool.query<{ persona_id: string; kind: string; total_tokens: number }>(
      `SELECT persona_id, meta_json->>'kind' AS kind, total_tokens FROM token_usage WHERE id = $1`,
      [reservation!.id],
    );
    expect(rows.rows[0]).toEqual({ persona_id: PROBE_ID, kind: "prospective_visual_tokens", total_tokens: 80 });
    expect(await reserveVisualTokens(store.pool, {
      mentionKey: `${PREFIX}image-settle-next`,
      publicKey: "image-settle-user",
      targetTokens: 21,
      globalCeiling: baseline + LARGE,
      userCeiling: LARGE,
      staleAfterMs: 300_000,
      persona: tokenPersona(probe, { imageDailyTokens: 100 }),
    })).toBeNull();
  });
});

describe("atomic web admission across fleet and persona layers", () => {
  const cfg = (daily: number) => ({ webPerMentionCap: 5, webDailyCeiling: daily });

  it("races persona and fleet web ceilings independently", async () => {
    const baseline = await webBaseline();
    const personaRace = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      reserveWebCall(store.pool, cfg(baseline + LARGE), {
        mentionKey: `${PREFIX}web-persona-${i}`,
        provider: "test",
        queryHash: `q${i}`,
        persona: { identity: probe, dailyCeiling: 2 },
      }),
    ));
    expect(personaRace.filter((gate) => !gate.blocked)).toHaveLength(2);
    expect(personaRace.filter((gate) => gate.reason === "persona_daily_web_ceiling")).toHaveLength(6);

    const midBaseline = await webBaseline();
    const fleetRace = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      reserveWebCall(store.pool, cfg(midBaseline + 3), {
        mentionKey: `${PREFIX}web-fleet-${i}`,
        provider: "test",
        queryHash: `f${i}`,
        persona: { identity: i % 2 === 0 ? jeb : probe, dailyCeiling: LARGE },
      }),
    ));
    expect(fleetRace.filter((gate) => !gate.blocked)).toHaveLength(3);
    expect(fleetRace.filter((gate) => gate.reason === "daily_web_ceiling")).toHaveLength(5);

    const rows = await store.pool.query<{ persona_id: string; n: number }>(
      `SELECT persona_id, count(*)::int AS n FROM web_queries WHERE mention_key LIKE $1 GROUP BY persona_id`,
      [`${PREFIX}web-%`],
    );
    expect(rows.rows.reduce((total, row) => total + row.n, 0)).toBe(5);
  });

  it("counts a finalized persona web call and keeps its persona stamp", async () => {
    const baseline = await webBaseline();
    const gate = await reserveWebCall(store.pool, cfg(baseline + LARGE), {
      mentionKey: `${PREFIX}web-final`,
      provider: "test",
      queryHash: "final",
      persona: { identity: probe, dailyCeiling: 1 },
    });
    await finalizeWebCall(store.pool, gate.reservationId!, { provider: "test", ok: true, sourcesCount: 1, durationMs: 1 });
    const next = await reserveWebCall(store.pool, cfg(baseline + LARGE), {
      mentionKey: `${PREFIX}web-final-next`,
      provider: "test",
      queryHash: "final-next",
      persona: { identity: probe, dailyCeiling: 1 },
    });
    expect(next).toEqual({ blocked: true, reason: "persona_daily_web_ceiling" });
    const row = await store.pool.query<{ persona_id: string; ok: boolean }>(
      "SELECT persona_id, ok FROM web_queries WHERE id = $1",
      [gate.reservationId],
    );
    expect(row.rows[0]).toEqual({ persona_id: PROBE_ID, ok: true });
  });

  it("fails closed when a persona layer cannot be admitted transactionally", async () => {
    const queryOnly = { query: store.pool.query.bind(store.pool) } as unknown as typeof store.pool;
    expect(await reserveWebCall(queryOnly, cfg(LARGE), {
      mentionKey: `${PREFIX}web-no-tx`,
      provider: "test",
      queryHash: "no-tx",
      persona: { identity: probe, dailyCeiling: LARGE },
    })).toEqual({ blocked: true, reason: "budgets_unavailable" });
  });
});

describe("atomic Scout admission across fleet and persona layers", () => {
  const cfg = (daily: number, perMention = 100) => ({
    scoutPerMentionCap: perMention,
    scoutDailyCeiling: daily,
    scoutRawPerUserDaily: 100,
    scoutRawGlobalDaily: 100,
  });

  it("races persona and fleet Scout ceilings independently and releases exact rows", async () => {
    const baseline = await scoutBaseline();
    const personaRace = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      reserveScoutCall(store.pool, cfg(baseline + LARGE), {
        tool: "search_posts",
        mentionKey: `${PREFIX}scout-persona-${i}`,
        raw: false,
        persona: { identity: probe, dailyCeiling: 3, perMentionCeiling: 10 },
      }),
    ));
    expect(personaRace.filter((gate) => !gate.blocked)).toHaveLength(3);
    expect(personaRace.filter((gate) => gate.reason === "persona_daily_scout_ceiling")).toHaveLength(5);

    const midBaseline = await scoutBaseline();
    const fleetRace = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      reserveScoutCall(store.pool, cfg(midBaseline + 2), {
        tool: "search_posts",
        mentionKey: `${PREFIX}scout-fleet-${i}`,
        raw: false,
        persona: { identity: i % 2 === 0 ? jeb : probe, dailyCeiling: LARGE, perMentionCeiling: 10 },
      }),
    ));
    expect(fleetRace.filter((gate) => !gate.blocked)).toHaveLength(2);
    expect(fleetRace.filter((gate) => gate.reason === "daily_scout_ceiling")).toHaveLength(6);

    const reserved = await store.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM scout_queries WHERE mention_key LIKE $1",
      [`${PREFIX}scout-%`],
    );
    expect(reserved.rows[0]!.n).toBe(5);
    for (const gate of [...personaRace, ...fleetRace]) {
      if (gate.reservationId) await releaseScoutCall(store.pool, gate.reservationId);
    }
    const released = await store.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM scout_queries WHERE mention_key LIKE $1",
      [`${PREFIX}scout-%`],
    );
    expect(released.rows[0]!.n).toBe(0);
  });

  it("applies the lower of the persona and fleet per-mention ceilings", async () => {
    const baseline = await scoutBaseline();
    const key = `${PREFIX}scout-mention`;
    const race = await Promise.all(Array.from({ length: 6 }, () =>
      reserveScoutCall(store.pool, cfg(baseline + LARGE, 10), {
        tool: "search_posts",
        mentionKey: key,
        raw: false,
        persona: { identity: probe, dailyCeiling: LARGE, perMentionCeiling: 2 },
      }),
    ));
    expect(race.filter((gate) => !gate.blocked)).toHaveLength(2);
    expect(race.filter((gate) => gate.reason === "per_mention_scout_cap")).toHaveLength(4);
  });

  it("fails closed when a persona layer cannot be admitted transactionally", async () => {
    const queryOnly = { query: store.pool.query.bind(store.pool) } as unknown as typeof store.pool;
    expect(await reserveScoutCall(queryOnly, cfg(LARGE), {
      tool: "search_posts",
      mentionKey: `${PREFIX}scout-no-tx`,
      raw: false,
      persona: { identity: probe, dailyCeiling: LARGE, perMentionCeiling: 10 },
    })).toEqual({ blocked: true, reason: "budgets_unavailable" });
  });
});
