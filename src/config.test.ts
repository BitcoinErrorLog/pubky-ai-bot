import { afterEach, describe, expect, it } from "vitest";
import { configFromProcessEnv } from "./config.js";

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
