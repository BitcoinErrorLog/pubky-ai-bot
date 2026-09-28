import type pg from "pg";

export type PersonaBudgetKind = "tokens" | "web" | "scout" | "image";

const COLUMNS: Record<PersonaBudgetKind, { reserved: string; used: string }> = {
  tokens: { reserved: "tokens_reserved", used: "tokens_used" },
  web: { reserved: "web_reserved", used: "web_used" },
  scout: { reserved: "scout_reserved", used: "scout_used" },
  image: { reserved: "image_tokens_reserved", used: "image_tokens_used" },
};

export function distributePersonaUsage(
  reservations: ReadonlyArray<{ day: string; amount: number }>,
  actual: number | null | undefined,
): Array<{ day: string; reserved: number; used: number }> {
  if (actual !== null && actual !== undefined && (!Number.isSafeInteger(actual) || actual < 0)) {
    throw new Error("invalid persona budget usage");
  }
  let remaining = actual ?? reservations.reduce((sum, item) => sum + item.amount, 0);
  const settlements = reservations.map((reservation) => {
    const used = Math.min(reservation.amount, Math.max(0, remaining));
    remaining -= used;
    return { day: reservation.day, reserved: reservation.amount, used };
  });
  if (remaining > 0) {
    const last = settlements.at(-1);
    if (!last) throw new Error("persona usage has no reservation");
    last.used += remaining;
  }
  return settlements;
}

export async function reservePersonaBudget(
  pool: pg.Pool,
  input: {
    personaId: string;
    kind: PersonaBudgetKind;
    amount: number;
    dailyCeiling: number;
    day?: string;
  },
): Promise<string | null> {
  if (!Number.isSafeInteger(input.amount) || input.amount < 0) throw new Error("invalid persona budget reservation");
  if (!Number.isSafeInteger(input.dailyCeiling) || input.dailyCeiling < 0) throw new Error("invalid persona budget ceiling");
  if (input.amount === 0) return input.day ?? new Date().toISOString().slice(0, 10);
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
     RETURNING day::text AS day`,
    [input.personaId, input.day ?? null, input.amount, input.dailyCeiling],
  );
  return result.rows[0]?.day ? String(result.rows[0].day) : null;
}

export async function settlePersonaBudget(
  pool: pg.Pool,
  input: {
    personaId: string;
    kind: PersonaBudgetKind;
    reserved: number;
    used: number;
    day: string;
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
  const result = await pool.query(
    `UPDATE persona_budget_day
     SET ${column.reserved} = GREATEST(0, ${column.reserved} - $3),
         ${column.used} = ${column.used} + $4,
         updated_at = now()
     WHERE persona_id = $1
       AND day = $2::date`,
    [input.personaId, input.day, input.reserved, input.used],
  );
  if (result.rowCount !== 1) throw new Error("persona budget settlement row missing");
}

export async function reservePersonaTokenBudget(
  pool: pg.Pool,
  input: {
    personaId: string;
    publicKey: string;
    amount: number;
    dailyCeiling: number;
    userDailyCeiling: number;
    day?: string;
  },
): Promise<string | null> {
  if (
    !Number.isSafeInteger(input.amount) ||
    input.amount < 0 ||
    !Number.isSafeInteger(input.dailyCeiling) ||
    input.dailyCeiling < 0 ||
    !Number.isSafeInteger(input.userDailyCeiling) ||
    input.userDailyCeiling < 0
  ) {
    throw new Error("invalid persona token reservation");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const global = await client.query(
      `INSERT INTO persona_budget_day (persona_id, day, tokens_reserved)
       VALUES ($1, COALESCE($4::date, (now() AT TIME ZONE 'UTC')::date), $3)
       ON CONFLICT (persona_id, day) DO UPDATE
       SET tokens_reserved = persona_budget_day.tokens_reserved + EXCLUDED.tokens_reserved,
           updated_at = now()
       WHERE persona_budget_day.tokens_reserved + persona_budget_day.tokens_used
           + EXCLUDED.tokens_reserved <= $2
       RETURNING day::text AS day`,
      [input.personaId, input.dailyCeiling, input.amount, input.day ?? null],
    );
    if (global.rowCount !== 1) {
      await client.query("ROLLBACK");
      return null;
    }
    const user = await client.query(
      `INSERT INTO persona_user_budget_day (persona_id, public_key, day, tokens_reserved)
       VALUES ($1, $2, COALESCE($5::date, (now() AT TIME ZONE 'UTC')::date), $4)
       ON CONFLICT (persona_id, public_key, day) DO UPDATE
       SET tokens_reserved = persona_user_budget_day.tokens_reserved + EXCLUDED.tokens_reserved,
           updated_at = now()
       WHERE persona_user_budget_day.tokens_reserved + persona_user_budget_day.tokens_used
           + EXCLUDED.tokens_reserved <= $3
       RETURNING day::text AS day`,
      [input.personaId, input.publicKey, input.userDailyCeiling, input.amount, input.day ?? null],
    );
    if (user.rowCount !== 1) {
      await client.query("ROLLBACK");
      return null;
    }
    await client.query("COMMIT");
    return String(user.rows[0].day);
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
    day: string;
  },
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const global = await client.query(
      `UPDATE persona_budget_day
       SET tokens_reserved = GREATEST(0, tokens_reserved - $2),
           tokens_used = tokens_used + $3,
           updated_at = now()
       WHERE persona_id = $1 AND day = $4::date`,
      [input.personaId, input.reserved, input.used, input.day],
    );
    const user = await client.query(
      `UPDATE persona_user_budget_day
       SET tokens_reserved = GREATEST(0, tokens_reserved - $3),
           tokens_used = tokens_used + $4,
           updated_at = now()
       WHERE persona_id = $1 AND public_key = $2
         AND day = $5::date`,
      [input.personaId, input.publicKey, input.reserved, input.used, input.day],
    );
    if (global.rowCount !== 1 || user.rowCount !== 1) {
      throw new Error("persona token settlement row missing");
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
