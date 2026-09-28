import type pg from "pg";

export type PersonaBudgetKind = "tokens" | "web" | "scout" | "image";

const COLUMNS: Record<PersonaBudgetKind, { reserved: string; used: string }> = {
  tokens: { reserved: "tokens_reserved", used: "tokens_used" },
  web: { reserved: "web_reserved", used: "web_used" },
  scout: { reserved: "scout_reserved", used: "scout_used" },
  image: { reserved: "image_tokens_reserved", used: "image_tokens_used" },
};

export async function reservePersonaBudget(
  pool: pg.Pool,
  input: {
    personaId: string;
    kind: PersonaBudgetKind;
    amount: number;
    dailyCeiling: number;
    day?: string;
  },
): Promise<boolean> {
  if (!Number.isSafeInteger(input.amount) || input.amount < 0) throw new Error("invalid persona budget reservation");
  if (!Number.isSafeInteger(input.dailyCeiling) || input.dailyCeiling < 0) throw new Error("invalid persona budget ceiling");
  if (input.amount === 0) return true;
  const column = COLUMNS[input.kind];
  const result = await pool.query(
    `INSERT INTO persona_budget_day (persona_id, day, ${column.reserved})
     VALUES ($1, COALESCE($2::date, (now() AT TIME ZONE 'UTC')::date), $3)
     ON CONFLICT (persona_id, day) DO UPDATE
     SET ${column.reserved} = persona_budget_day.${column.reserved} + EXCLUDED.${column.reserved},
         updated_at = now()
     WHERE persona_budget_day.${column.reserved}
         + persona_budget_day.${column.used}
         + EXCLUDED.${column.reserved} <= $4
     RETURNING persona_id`,
    [input.personaId, input.day ?? null, input.amount, input.dailyCeiling],
  );
  return result.rowCount === 1;
}

export async function settlePersonaBudget(
  pool: pg.Pool,
  input: {
    personaId: string;
    kind: PersonaBudgetKind;
    reserved: number;
    used: number;
    day?: string;
  },
): Promise<void> {
  if (
    !Number.isSafeInteger(input.reserved) ||
    input.reserved < 0 ||
    !Number.isSafeInteger(input.used) ||
    input.used < 0
  ) {
    throw new Error("invalid persona budget settlement");
  }
  const column = COLUMNS[input.kind];
  await pool.query(
    `UPDATE persona_budget_day
     SET ${column.reserved} = GREATEST(0, ${column.reserved} - $3),
         ${column.used} = ${column.used} + $4,
         updated_at = now()
     WHERE persona_id = $1
       AND day = COALESCE($2::date, (now() AT TIME ZONE 'UTC')::date)`,
    [input.personaId, input.day ?? null, input.reserved, input.used],
  );
}

export async function reservePersonaTokenBudget(
  pool: pg.Pool,
  input: {
    personaId: string;
    publicKey: string;
    amount: number;
    dailyCeiling: number;
    userDailyCeiling: number;
  },
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const global = await client.query(
      `INSERT INTO persona_budget_day (persona_id, day, tokens_reserved)
       VALUES ($1, (now() AT TIME ZONE 'UTC')::date, $3)
       ON CONFLICT (persona_id, day) DO UPDATE
       SET tokens_reserved = persona_budget_day.tokens_reserved + EXCLUDED.tokens_reserved,
           updated_at = now()
       WHERE persona_budget_day.tokens_reserved + persona_budget_day.tokens_used
           + EXCLUDED.tokens_reserved <= $2
       RETURNING persona_id`,
      [input.personaId, input.dailyCeiling, input.amount],
    );
    if (global.rowCount !== 1) {
      await client.query("ROLLBACK");
      return false;
    }
    const user = await client.query(
      `INSERT INTO persona_user_budget_day (persona_id, public_key, day, tokens_reserved)
       VALUES ($1, $2, (now() AT TIME ZONE 'UTC')::date, $4)
       ON CONFLICT (persona_id, public_key, day) DO UPDATE
       SET tokens_reserved = persona_user_budget_day.tokens_reserved + EXCLUDED.tokens_reserved,
           updated_at = now()
       WHERE persona_user_budget_day.tokens_reserved + persona_user_budget_day.tokens_used
           + EXCLUDED.tokens_reserved <= $3
       RETURNING persona_id`,
      [input.personaId, input.publicKey, input.userDailyCeiling, input.amount],
    );
    if (user.rowCount !== 1) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function settlePersonaTokenBudget(
  pool: pg.Pool,
  input: {
    personaId: string;
    publicKey: string;
    reserved: number;
    used: number;
  },
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE persona_budget_day
       SET tokens_reserved = GREATEST(0, tokens_reserved - $2),
           tokens_used = tokens_used + $3,
           updated_at = now()
       WHERE persona_id = $1 AND day = (now() AT TIME ZONE 'UTC')::date`,
      [input.personaId, input.reserved, input.used],
    );
    await client.query(
      `UPDATE persona_user_budget_day
       SET tokens_reserved = GREATEST(0, tokens_reserved - $3),
           tokens_used = tokens_used + $4,
           updated_at = now()
       WHERE persona_id = $1 AND public_key = $2
         AND day = (now() AT TIME ZONE 'UTC')::date`,
      [input.personaId, input.publicKey, input.reserved, input.used],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
