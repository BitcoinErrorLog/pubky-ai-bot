import { describe, expect, it } from "vitest";
import {
  EXECUTOR_FORBIDDEN_ENV_NAMES,
  KEY_SOURCE_ENV_NAMES,
  PLANNER_FORBIDDEN_ENV_NAMES,
  assertExecutorEnvContract,
  assertPlannerEnvContract,
} from "./resource-env-contract.js";
import { RESOURCE_ERROR_CODES, CodedResourceError, resourceErrorCode } from "./resource-error-code.js";

const SENTINEL = "sk-live-DO-NOT-LEAK-4f2a";

function executorEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { PUBKY_BOT_SECRET_KEY_HEX: "ab".repeat(32), ...extra };
}

describe("resource env contracts", () => {
  it("accepts a planner with no credentials and an executor with exactly one key", () => {
    expect(() => assertPlannerEnvContract({ JEB_MODEL_API_KEY: SENTINEL })).not.toThrow();
    expect(() => assertExecutorEnvContract(executorEnv())).not.toThrow();
  });

  // Deliberate negative: truthiness was the old test, and an empty credential
  // name is a deployment defect, not an absence.
  it("treats an empty credential variable as present", () => {
    for (const name of KEY_SOURCE_ENV_NAMES) {
      expect(() => assertPlannerEnvContract({ [name]: "" })).toThrow(`forbids: ${name}`);
    }
    expect(() => assertExecutorEnvContract({ PUBKY_BOT_SECRET_KEY_HEX: "   " })).toThrow("key source is empty");
    expect(() => assertExecutorEnvContract(executorEnv({ JEB_SIGNUP_TOKEN: "" }))).toThrow("forbids: JEB_SIGNUP_TOKEN");
  });

  it("refuses every forbidden name individually, in both processes", () => {
    for (const name of PLANNER_FORBIDDEN_ENV_NAMES) {
      expect(() => assertPlannerEnvContract({ [name]: SENTINEL })).toThrow(`forbids: ${name}`);
    }
    for (const name of EXECUTOR_FORBIDDEN_ENV_NAMES) {
      expect(() => assertExecutorEnvContract(executorEnv({ [name]: SENTINEL }))).toThrow(`forbids: ${name}`);
    }
  });

  it("refuses every unapproved PUBKY_BOT variable", () => {
    expect(() => assertExecutorEnvContract(executorEnv({ PUBKY_BOT_UNAPPROVED: "" }))).toThrow("PUBKY_BOT_UNAPPROVED");
  });

  // Deliberate negative: with two key sources the loader's priority order,
  // not the operator, decides which identity signs.
  it("refuses a second key source and a missing key source", () => {
    expect(() =>
      assertExecutorEnvContract({ PUBKY_BOT_SECRET_KEY_HEX: "ab".repeat(32), PUBKY_BOT_MNEMONIC: "word ".repeat(12) }),
    ).toThrow("forbids a second key source");
    expect(() => assertExecutorEnvContract({})).toThrow("requires exactly one key source");
  });

  it("never quotes a credential value in its own refusal", () => {
    for (const assert of [
      () => assertPlannerEnvContract({ JEB_SIGNUP_TOKEN: SENTINEL }),
      () => assertExecutorEnvContract(executorEnv({ JEB_MODEL_API_KEY: SENTINEL })),
      () => assertExecutorEnvContract({ PUBKY_BOT_SECRET_KEY_HEX: SENTINEL, PUBKY_BOT_MNEMONIC: SENTINEL }),
    ]) {
      let message = "";
      try {
        assert();
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).not.toBe("");
      expect(message).not.toContain(SENTINEL);
      expect(message).not.toContain("sk-live");
    }
  });

  it("reports contract violations as a bounded config refusal", () => {
    try {
      assertExecutorEnvContract({});
    } catch (error) {
      expect(error).toBeInstanceOf(CodedResourceError);
      expect(resourceErrorCode(error)).toBe("config_refused");
    }
  });
});

describe("bounded error codes", () => {
  it("never derives a code from message text", () => {
    const hostile = new Error(`https://user:${SENTINEL}@relay.example/link/abc capability_refused`);
    expect(resourceErrorCode(hostile)).toBe("unknown_failure");
    expect(RESOURCE_ERROR_CODES).toContain(resourceErrorCode(hostile));
  });

  it("passes through a code the thrower already bounded", () => {
    expect(resourceErrorCode(new CodedResourceError("capability_refused"))).toBe("capability_refused");
    expect(resourceErrorCode({ code: "plan_drift" })).toBe("plan_drift");
    // An attacker-chosen `code` that is not in the vocabulary is discarded.
    expect(resourceErrorCode({ code: "root_session_granted" })).toBe("unknown_failure");
  });

  it("maps the fixed Node errno vocabulary and honours a caller fallback", () => {
    expect(resourceErrorCode({ code: "ECONNREFUSED" })).toBe("homeserver_unavailable");
    expect(resourceErrorCode({ code: "ETIMEDOUT" })).toBe("timeout");
    expect(resourceErrorCode(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe("timeout");
    expect(resourceErrorCode(new Error("boom"), "model_failed")).toBe("model_failed");
  });

  it("emits only codes from the declared vocabulary", () => {
    const samples: unknown[] = [
      new Error("x"),
      "string error",
      null,
      undefined,
      { code: 42 },
      new CodedResourceError("spend_cap_exceeded"),
    ];
    for (const sample of samples) expect(RESOURCE_ERROR_CODES).toContain(resourceErrorCode(sample));
  });
});
