import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Store } from "../db.js";
import {
  reservePersonaBudget,
  reservePersonaTokenBudget,
  settlePersonaTokenBudget,
} from "./budget.js";

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
    expect(results.sort()).toEqual([false, true]);
    await settlePersonaTokenBudget(store.pool, {
      personaId: PERSONA,
      publicKey: USER,
      reserved: 60,
      used: 40,
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

  it("atomically enforces a persona web-call ceiling", async () => {
    const results = await Promise.all([
      reservePersonaBudget(store.pool, { personaId: PERSONA, kind: "web", amount: 1, dailyCeiling: 2 }),
      reservePersonaBudget(store.pool, { personaId: PERSONA, kind: "web", amount: 1, dailyCeiling: 2 }),
      reservePersonaBudget(store.pool, { personaId: PERSONA, kind: "web", amount: 1, dailyCeiling: 2 }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(2);
  });
});
