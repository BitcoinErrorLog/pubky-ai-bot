import { afterEach, describe, expect, it } from "vitest";
import {
  assertPubchiBindAllowed,
  corsHeadersForOrigin,
  isLoopbackBind,
  ownerBudgetKey,
  parseAllowedOrigins,
  parsePubchiAudienceOrigins,
  parsePubchiDelegationCapAt,
  parsePubchiPort,
  parsePubchiV1Sunset,
  pubchiCohortSalt,
  pubchiOwnerInCohort,
  parsePubchiComposedCypherCohortPercent,
  parsePubchiPlannerCohortPercent,
  pubchiBind,
  scoutMentionKey,
} from "./env.js";

afterEach(() => {
  delete process.env.PUBCHI_BIND_DANGEROUS;
  delete process.env.PUBCHI_ALLOWED_ORIGINS;
  delete process.env.PUBCHI_COHORT_SALT;
  delete process.env.PUBCHI_COMPOSED_CYPHER_COHORT_PERCENT;
  delete process.env.PUBCHI_PLANNER_COHORT_PERCENT;
  delete process.env.PUBCHI_PLANNER_ENABLED;
});

describe("Pubchi owner cohorts", () => {
  it("is deterministic with explicit 0 and 100 boundaries", () => {
    expect(pubchiOwnerInCohort("owner", 0, "salt")).toBe(false);
    expect(pubchiOwnerInCohort("owner", 100, "salt")).toBe(true);
    expect(pubchiOwnerInCohort("owner", 50, "salt")).toBe(pubchiOwnerInCohort("owner", 50, "salt"));
  });

  it("requires a salt for non-empty cohorts", () => {
    process.env.PUBCHI_COMPOSED_CYPHER_COHORT_PERCENT = "10";
    expect(() => pubchiCohortSalt("")).toThrow(/PUBCHI_COHORT_SALT/);
    expect(parsePubchiComposedCypherCohortPercent("10")).toBe(10);
    expect(parsePubchiPlannerCohortPercent("100")).toBe(100);
  });
});

describe("bind validation", () => {
  it("defaults to loopback and accepts only IP literals", () => {
    expect(pubchiBind(undefined)).toBe("127.0.0.1");
    expect(pubchiBind("")).toBe("127.0.0.1");
    expect(pubchiBind("::1")).toBe("::1");
    expect(isLoopbackBind("127.0.0.1")).toBe(true);
    expect(isLoopbackBind("8.8.8.8")).toBe(false);
    expect(() => pubchiBind("localhost")).toThrow(/invalid PUBCHI_BIND/);
  });

  it("refuses a non-loopback bind without PUBCHI_BIND_DANGEROUS", () => {
    expect(() => assertPubchiBindAllowed("8.8.8.8")).toThrow(/PUBCHI_BIND_DANGEROUS/);
  });

  it("allows a non-loopback bind when PUBCHI_BIND_DANGEROUS=1", () => {
    process.env.PUBCHI_BIND_DANGEROUS = "1";
    expect(() => assertPubchiBindAllowed("8.8.8.8")).not.toThrow();
  });

  it("parses PUBCHI_PORT", () => {
    expect(parsePubchiPort(undefined)).toBe(3015);
    expect(parsePubchiPort("4010")).toBe(4010);
    expect(() => parsePubchiPort("nope")).toThrow(/invalid PUBCHI_PORT/);
  });
});

describe("owner budget key", () => {
  it("keys by owner only, ignoring bot", () => {
    expect(ownerBudgetKey("owner1")).toBe("pubchi:owner1");
    expect(scoutMentionKey("bot-a", "owner1")).toBe("pubchi:owner1");
    expect(scoutMentionKey("bot-b", "owner1")).toBe(scoutMentionKey("bot-a", "owner1"));
  });
});

describe("PUBCHI_ALLOWED_ORIGINS", () => {
  it("empty env → no origins", () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(parseAllowedOrigins("")).toEqual([]);
    expect(parseAllowedOrigins("  ")).toEqual([]);
    expect(corsHeadersForOrigin("http://localhost:3001", [])).toBeNull();
  });

  it("allowed origin gets ACAO + Vary; unknown origin gets none", () => {
    const allowed = parseAllowedOrigins("http://localhost:3001, http://127.0.0.1:3001");
    expect(corsHeadersForOrigin("http://localhost:3001", allowed)).toEqual({
      "Access-Control-Allow-Origin": "http://localhost:3001",
      Vary: "Origin",
    });
    expect(corsHeadersForOrigin("https://evil.example", allowed)).toBeNull();
    expect(corsHeadersForOrigin("*", allowed)).toBeNull();
    expect(corsHeadersForOrigin("http://localhost:3001", ["http://localhost:3001"])).not.toHaveProperty(
      "Access-Control-Allow-Credentials",
    );
  });
});

describe("PUBCHI_AUDIENCE_ORIGINS", () => {
  it("requires at least one API deployment origin", () => {
    expect(() => parsePubchiAudienceOrigins("")).toThrow(/PUBCHI_AUDIENCE_ORIGINS/);
    expect(() => parsePubchiAudienceOrigins("  ")).toThrow(/PUBCHI_AUDIENCE_ORIGINS/);
  });

  it("normalizes and accepts multiple API origins", () => {
    expect(parsePubchiAudienceOrigins("https://PUBCHI.example, https://api.example")).toEqual([
      "https://pubchi.example",
      "https://api.example",
    ]);
  });

  it("does not treat browser CORS origins as audiences unless listed", () => {
    expect(parsePubchiAudienceOrigins("https://pubky.app")).toEqual(["https://pubky.app"]);
    expect(() => parsePubchiAudienceOrigins("https://pubky.app/path")).toThrow(/origin/);
  });
});

describe("Pubchi cutover timestamps", () => {
  it.each([
    ["PUBCHI_V1_SUNSET", parsePubchiV1Sunset],
    ["PUBCHI_DELEGATION_CAP_AT", parsePubchiDelegationCapAt],
  ])("requires a timezone on %s", (_name, parse) => {
    expect(() => parse("2026-10-09T00:00:00")).toThrow(/invalid/);
    expect(parse("2026-10-09T00:00:00Z")).toBe(1_791_504_000);
    expect(parse("2026-10-09T00:00:00+02:00")).toBe(1_791_496_800);
  });
});
