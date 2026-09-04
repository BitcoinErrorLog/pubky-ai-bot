import { describe, expect, it } from "vitest";
import { gitChildEnv } from "./ingest.js";

describe("git child env (D3)", () => {
  it("exposes only PATH, HOME, and git config isolation vars", () => {
    const env = gitChildEnv();
    expect(Object.keys(env).sort()).toEqual(
      ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_TERMINAL_PROMPT", "HOME", "PATH"].sort(),
    );
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.JEB_SECRET_KEY).toBeUndefined();
    expect(env.PUBKY_BOT_SECRET_KEY_HEX).toBeUndefined();
  });
});
