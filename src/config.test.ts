import { afterEach, describe, expect, it, vi } from "vitest";
import { configFromProcessEnv, warnLowProductionLimits } from "./config.js";
import { log } from "./log.js";

const saved = { ...process.env };

afterEach(() => {
  for (const k of ["DATABASE_URL", "JEB_DB_URL_REASON", "JEB_DB_URL_INGEST", "JEB_SCRUB_DISABLED_RULES"])
    delete process.env[k];
  Object.assign(process.env, saved);
});

function withDbEnv(extra: Record<string, string>): void {
  delete process.env.JEB_DB_URL_REASON;
  delete process.env.JEB_DB_URL_INGEST;
  process.env.DATABASE_URL = "postgres://shared@127.0.0.1:5432/jeb";
  Object.assign(process.env, extra);
}

describe("per-role database URLs (JEB_DB_URL_REASON / JEB_DB_URL_INGEST)", () => {
  it("reason role prefers JEB_DB_URL_REASON", () => {
    withDbEnv({ JEB_DB_URL_REASON: "postgres://jeb_reason@127.0.0.1:5432/jeb" });
    const cfg = configFromProcessEnv({ requireSecret: false, role: "reason" });
    expect(cfg.databaseUrl).toBe("postgres://jeb_reason@127.0.0.1:5432/jeb");
  });

  it("reason role falls back to DATABASE_URL", () => {
    withDbEnv({});
    const cfg = configFromProcessEnv({ requireSecret: false, role: "reason" });
    expect(cfg.databaseUrl).toBe("postgres://shared@127.0.0.1:5432/jeb");
  });

  it("ingest role prefers JEB_DB_URL_INGEST", () => {
    withDbEnv({ JEB_DB_URL_INGEST: "postgres://jeb_ingest@127.0.0.1:5432/jeb" });
    const cfg = configFromProcessEnv({ requireSecret: false, role: "ingest" });
    expect(cfg.databaseUrl).toBe("postgres://jeb_ingest@127.0.0.1:5432/jeb");
  });

  it("publish role ignores the per-role URLs", () => {
    withDbEnv({
      JEB_DB_URL_REASON: "postgres://jeb_reason@127.0.0.1:5432/jeb",
      JEB_DB_URL_INGEST: "postgres://jeb_ingest@127.0.0.1:5432/jeb",
    });
    const cfg = configFromProcessEnv({ requireSecret: false, role: "publish" });
    expect(cfg.databaseUrl).toBe("postgres://shared@127.0.0.1:5432/jeb");
  });
});

describe("JEB_SCRUB_DISABLED_RULES (scrubber emergency valve)", () => {
  it("defaults to an empty set", () => {
    withDbEnv({});
    const cfg = configFromProcessEnv({ requireSecret: false, role: "reason" });
    expect(cfg.scrubDisabledRules.size).toBe(0);
  });
  it("parses a comma-separated list of rule ids", () => {
    withDbEnv({ JEB_SCRUB_DISABLED_RULES: "bip39, env_assignment" });
    const cfg = configFromProcessEnv({ requireSecret: false, role: "reason" });
    expect(cfg.scrubDisabledRules).toEqual(new Set(["bip39", "env_assignment"]));
  });
});

describe("startup safety for unusually low production limits", () => {
  afterEach(() => {
    delete process.env.JEB_DAILY_TOKEN_BUDGET;
    delete process.env.JEB_MAX_REPLIES_PER_THREAD;
    delete process.env.JEB_USER_DAILY_TOKEN_BUDGET;
    Object.assign(process.env, saved);
  });

  it("defaults global budget to 5e6, user budget to 600k, toolMaxSteps to 4", () => {
    withDbEnv({});
    delete process.env.JEB_DAILY_TOKEN_BUDGET;
    delete process.env.JEB_USER_DAILY_TOKEN_BUDGET;
    delete process.env.JEB_TOOL_MAX_STEPS;
    delete process.env.JEB_MAX_REPLIES_PER_THREAD;
    const cfg = configFromProcessEnv({ requireSecret: false, role: "reason" });
    expect(cfg.dailyTokenBudget).toBe(5_000_000);
    expect(cfg.userDailyTokenBudget).toBe(600_000);
    expect(cfg.toolMaxSteps).toBe(4);
    expect(cfg.maxRepliesPerThread).toBe(12);
  });

  it("warns when JEB_DAILY_TOKEN_BUDGET or JEB_MAX_REPLIES_PER_THREAD are unusually low", () => {
    const spy = vi.spyOn(log, "warn");
    warnLowProductionLimits({ dailyTokenBudget: 200_000, maxRepliesPerThread: 1 });
    const msgs = spy.mock.calls.map((c) => String(c[1]));
    expect(msgs.some((m) => m.includes("unusually low") && m.includes("5000000"))).toBe(true);
    expect(msgs.some((m) => m.includes("unusually low") && m.includes("12"))).toBe(true);
    const vars = spy.mock.calls.map((c) => (c[0] as { var?: string }).var);
    expect(vars).toContain("JEB_DAILY_TOKEN_BUDGET");
    expect(vars).toContain("JEB_MAX_REPLIES_PER_THREAD");
    spy.mockRestore();
  });

  it("does not warn at production defaults", () => {
    const spy = vi.spyOn(log, "warn");
    warnLowProductionLimits({ dailyTokenBudget: 5_000_000, maxRepliesPerThread: 12 });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("logs the warn from configFromProcessEnv when env is low", () => {
    withDbEnv({ JEB_DAILY_TOKEN_BUDGET: "999", JEB_MAX_REPLIES_PER_THREAD: "1" });
    const spy = vi.spyOn(log, "warn");
    configFromProcessEnv({ requireSecret: false, role: "reason" });
    expect(spy.mock.calls.some((c) => (c[0] as { var?: string }).var === "JEB_DAILY_TOKEN_BUDGET")).toBe(true);
    spy.mockRestore();
  });
});
