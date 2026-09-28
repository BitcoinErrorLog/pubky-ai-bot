import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Store } from "../db.js";
import {
  distributePersonaUsage,
  reservePersonaBudget,
  reservePersonaTokenBudget,
  settlePersonaBudget,
  settlePersonaTokenBudget,
} from "./budget.js";
import { executePersonaBudgetedTool } from "./tool-budget.js";

const url = process.env.DATABASE_URL ?? "postgres://johncarvalho@127.0.0.1:5432/jeb_vitest";
const PERSONA = "jeb";
const USER = "budget-user";

describe("persona budget reservations", () => {
  let store: Store;

  beforeAll(async () => {
    store = new Store(url);
    await store.migrate();
    await store.pool.query("DELETE FROM persona_user_budget_day WHERE persona_id = $1", [PERSONA]);
    await store.pool.query("DELETE FROM persona_budget_day WHERE persona_id = $1", [PERSONA]);
  });

  afterAll(async () => {
    await store.pool.query("DELETE FROM persona_user_budget_day WHERE persona_id = $1", [PERSONA]);
    await store.pool.query("DELETE FROM persona_budget_day WHERE persona_id = $1", [PERSONA]);
    await store.close();
  });

  it("atomically admits only one crossing token reservation", async () => {
    const results = await Promise.all([
      reservePersonaTokenBudget(store.pool, {
        personaId: PERSONA,
        publicKey: USER,
        amount: 60,
        dailyCeiling: 100,
        userDailyCeiling: 100,
      }),
      reservePersonaTokenBudget(store.pool, {
        personaId: PERSONA,
        publicKey: USER,
        amount: 60,
        dailyCeiling: 100,
        userDailyCeiling: 100,
      }),
    ]);
    const acceptedDay = results.find((day): day is string => day !== null);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(acceptedDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await settlePersonaTokenBudget(store.pool, {
      personaId: PERSONA,
      publicKey: USER,
      reserved: 60,
      used: 40,
      day: acceptedDay!,
    });
    const row = await store.pool.query<{
      tokens_reserved: string;
      tokens_used: string;
    }>(
      "SELECT tokens_reserved::text, tokens_used::text FROM persona_budget_day WHERE persona_id = $1",
      [PERSONA],
    );
    expect(row.rows[0]).toEqual({ tokens_reserved: "0", tokens_used: "40" });
  });

  it("distributes reported usage across the exact reservations", () => {
    const reservations = [
      { day: "2026-09-26", amount: 100 },
      { day: "2026-09-27", amount: 80 },
    ];
    expect(distributePersonaUsage(reservations, 130)).toEqual([
      { day: "2026-09-26", reserved: 100, used: 100 },
      { day: "2026-09-27", reserved: 80, used: 30 },
    ]);
    expect(distributePersonaUsage(reservations, null)).toEqual([
      { day: "2026-09-26", reserved: 100, used: 100 },
      { day: "2026-09-27", reserved: 80, used: 80 },
    ]);
    expect(distributePersonaUsage(reservations, 200)).toEqual([
      { day: "2026-09-26", reserved: 100, used: 100 },
      { day: "2026-09-27", reserved: 80, used: 100 },
    ]);
  });

  it("atomically enforces a persona web-call ceiling", async () => {
    const results = await Promise.all([
      reservePersonaBudget(store.pool, { personaId: PERSONA, kind: "web", amount: 1, dailyCeiling: 2 }),
      reservePersonaBudget(store.pool, { personaId: PERSONA, kind: "web", amount: 1, dailyCeiling: 2 }),
      reservePersonaBudget(store.pool, { personaId: PERSONA, kind: "web", amount: 1, dailyCeiling: 2 }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(2);
  });

  it("rejects a first reservation larger than its ceiling", async () => {
    await expect(reservePersonaBudget(store.pool, {
      personaId: PERSONA,
      kind: "image",
      amount: 101,
      dailyCeiling: 100,
    })).resolves.toBeNull();
    await expect(reservePersonaTokenBudget(store.pool, {
      personaId: PERSONA,
      publicKey: USER,
      amount: 101,
      dailyCeiling: 100,
      userDailyCeiling: 100,
    })).resolves.toBeNull();
  });

  it("settles the exact reserved UTC day", async () => {
    const day = "2026-09-26";
    const tokenDay = await reservePersonaTokenBudget(store.pool, {
      personaId: PERSONA,
      publicKey: USER,
      amount: 25,
      dailyCeiling: 100,
      userDailyCeiling: 100,
      day,
    });
    const imageDay = await reservePersonaBudget(store.pool, {
      personaId: PERSONA,
      kind: "image",
      amount: 10,
      dailyCeiling: 100,
      day,
    });
    expect(tokenDay).toBe(day);
    expect(imageDay).toBe(day);

    await settlePersonaTokenBudget(store.pool, {
      personaId: PERSONA,
      publicKey: USER,
      reserved: 25,
      used: 20,
      day: tokenDay!,
    });
    await settlePersonaBudget(store.pool, {
      personaId: PERSONA,
      kind: "image",
      reserved: 10,
      used: 0,
      day: imageDay!,
    });

    const row = await store.pool.query<{
      tokens_reserved: string;
      tokens_used: string;
      image_tokens_reserved: string;
      image_tokens_used: string;
    }>(
      `SELECT tokens_reserved::text, tokens_used::text,
              image_tokens_reserved::text, image_tokens_used::text
       FROM persona_budget_day
       WHERE persona_id = $1 AND day = $2::date`,
      [PERSONA, day],
    );
    expect(row.rows[0]).toEqual({
      tokens_reserved: "0",
      tokens_used: "20",
      image_tokens_reserved: "0",
      image_tokens_used: "0",
    });
  });

  it("returns persona tool ceilings in-band without executing the tool", async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    const result = await executePersonaBudgetedTool(
      store.pool,
      {
        personaId: PERSONA,
        kind: "web",
        calls: 1,
        perMentionCeiling: 1,
        dailyCeiling: 100,
        onReserved: () => undefined,
      },
      execute,
    );
    expect(result).toEqual(expect.objectContaining({ error: "persona_budget" }));
    expect(execute).not.toHaveBeenCalled();
  });

  it("releases tool reservations on in-band errors and thrown failures", async () => {
    const onReserved = vi.fn();
    const denied = await executePersonaBudgetedTool(
      store.pool,
      {
        personaId: PERSONA,
        kind: "scout",
        calls: 0,
        perMentionCeiling: 2,
        dailyCeiling: 100,
        onReserved,
      },
      async () => ({ error: "fleet_denied" }),
    );
    expect(denied).toEqual({ error: "fleet_denied" });
    await expect(executePersonaBudgetedTool(
      store.pool,
      {
        personaId: PERSONA,
        kind: "scout",
        calls: 1,
        perMentionCeiling: 2,
        dailyCeiling: 100,
        onReserved,
      },
      async () => {
        throw new Error("tool failed");
      },
    )).rejects.toThrow("tool failed");
    expect(onReserved).toHaveBeenCalledTimes(2);

    const row = await store.pool.query<{ scout_reserved: string; scout_used: string }>(
      `SELECT scout_reserved::text, scout_used::text
       FROM persona_budget_day
       WHERE persona_id = $1 AND day = (now() AT TIME ZONE 'UTC')::date`,
      [PERSONA],
    );
    expect(row.rows[0]).toMatchObject({ scout_reserved: "0", scout_used: "0" });
  });
});
