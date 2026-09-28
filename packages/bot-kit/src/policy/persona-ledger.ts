/**
 * Persona identity stamped on a ledger row (`token_usage`, `web_queries`,
 * `scout_queries`). Every persona budget layer is derived from those rows, so
 * one admitted row is one reservation across fleet and persona layers.
 */
export type PersonaLedgerIdentity = {
  id: string;
  version: string;
  manifestHash: string;
  botPk: string;
};

export function assertCeiling(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid ${label}`);
}
