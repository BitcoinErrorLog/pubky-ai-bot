import type pg from "pg";
import {
  reservePersonaBudget,
  settlePersonaBudget,
  type PersonaBudgetKind,
} from "./budget.js";

type PersonaToolBudgetKind = Extract<PersonaBudgetKind, "web" | "scout">;

function isToolError(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && "error" in value);
}

export async function executePersonaBudgetedTool(
  pool: pg.Pool,
  input: {
    personaId: string;
    kind: PersonaToolBudgetKind;
    calls: number;
    perMentionCeiling: number;
    dailyCeiling: number;
    onReserved: () => void;
  },
  execute: () => Promise<unknown>,
): Promise<unknown> {
  if (input.calls >= input.perMentionCeiling) {
    return { error: "persona_budget", message: `${input.kind} per-mention budget exceeded` };
  }
  const day = await reservePersonaBudget(pool, {
    personaId: input.personaId,
    kind: input.kind,
    amount: 1,
    dailyCeiling: input.dailyCeiling,
  });
  if (!day) return { error: "persona_budget", message: `${input.kind} daily budget exceeded` };

  input.onReserved();
  let used = 0;
  try {
    const value = await execute();
    used = isToolError(value) ? 0 : 1;
    return value;
  } finally {
    await settlePersonaBudget(pool, {
      personaId: input.personaId,
      kind: input.kind,
      reserved: 1,
      used,
      day,
    });
  }
}
