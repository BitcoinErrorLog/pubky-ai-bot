export type ComposeResult =
  | { ok: true; cypher: string; params: Record<string, unknown>; limit: number; anchors: string[] }
  | { ok: false; code: string; hint: string; path?: string };

export type ComposerPort = {
  composeCypher(input: {
    query: string;
    params: Record<string, unknown>;
    tenant: { owner: string };
    schema: unknown;
    untrustedTexts: string[];
    scopeKind?: "whole_graph" | "owner_network";
  }): ComposeResult;
  revalidateResolvedParams(params: Record<string, unknown>): void;
};

export type ScoutCallMeter = {
  record(durationMs: number): void;
  assertBudget(): void;
  snapshot(): { calls: number; scoutMs: number };
};

export type ComposedQueryBudget = {
  allow(owner: string): Promise<boolean>;
};
