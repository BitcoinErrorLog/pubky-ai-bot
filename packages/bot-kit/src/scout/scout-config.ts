/** Narrow config surface Scout consumes. Jeb `Config` is a structural superset. */
export type ScoutClientConfig = {
  scoutUrl: string;
  scoutTimeoutMs: number;
  scoutLimitMax: number;
  scoutMaxQps?: number;
};

export type ScoutBudgetConfig = {
  scoutPerMentionCap: number;
  scoutDailyCeiling: number;
  scoutRawPerUserDaily: number;
  scoutRawGlobalDaily: number;
};

export type ScoutToolsConfig = ScoutClientConfig &
  ScoutBudgetConfig & {
    scoutEnabled: boolean;
    scoutRawEnabled: boolean;
    scoutProfilePropMax: number;
    scoutClaimantCap: number;
  };

export type ScoutSchemaCacheConfig = Pick<ScoutClientConfig, "scoutUrl" | "scoutTimeoutMs"> & {
  scoutSchemaRefreshMs: number;
};

export type ScoutCanaryConfig = ScoutSchemaCacheConfig & {
  scoutCanaryUnknownThreshold: number;
};

export type ScoutEnvSwitchOn = (name: "scout" | "global") => boolean;

/** Same env names as `src/switches.ts` (`JEB_DISABLED`, `JEB_SWITCH_*`). */
export function defaultScoutEnvSwitchOn(name: "scout" | "global"): boolean {
  if (process.env.JEB_DISABLED === "1") return true;
  if (process.env.JEB_SWITCH_GLOBAL === "1") return true;
  const key = `JEB_SWITCH_${name.toUpperCase()}`;
  return process.env[key] === "1";
}
