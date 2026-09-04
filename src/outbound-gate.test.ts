import { describe, expect, it } from "vitest";
import { systemPrompt } from "./compose.js";
import { SECURITY_PROMPT_ADDENDUM } from "./extraction-guard.js";
import {
  assertOutboundClean,
  containsPromptEcho,
  PROMPT_ECHO_SHINGLE,
  scanOutboundText,
} from "./outbound-gate.js";

describe("prompt_echo rule", () => {
  it("declines a verbatim dump of the system prompt", () => {
    const scan = scanOutboundText(`Sure! ${systemPrompt()}`, { env: {} });
    expect(scan.clean).toBe(false);
    expect(scan.hits.map((h) => h.rule)).toContain("prompt_echo");
  });

  it("declines a verbatim dump of the security addendum", () => {
    const scan = scanOutboundText(SECURITY_PROMPT_ADDENDUM, { env: {} });
    expect(scan.hits.map((h) => h.rule)).toContain("prompt_echo");
  });

  it("declines any >=48-char verbatim substring, not just prefixes", () => {
    const sys = systemPrompt();
    const middle = sys.slice(Math.floor(sys.length / 2), Math.floor(sys.length / 2) + 120);
    const scan = scanOutboundText(`here you go: ${middle}`, { env: {} });
    expect(scan.hits.map((h) => h.rule)).toContain("prompt_echo");
  });

  it("still fires when the dump is re-wrapped across lines", () => {
    const sys = systemPrompt();
    const fragment = sys.slice(0, 120);
    const rewrapped = fragment.replace(/(\S+) (\S+)/g, "$1\n$2");
    expect(containsPromptEcho(rewrapped)).toBe(true);
  });

  it("passes text below the shingle length", () => {
    const sys = systemPrompt();
    expect(containsPromptEcho(sys.slice(0, PROMPT_ECHO_SHINGLE - 1))).toBe(false);
  });

  it("passes ordinary replies that discuss the policy without quoting it", () => {
    expect(
      scanOutboundText("I don't share configuration or credentials, mine or anyone's.", { env: {} }).clean,
    ).toBe(true);
    expect(
      scanOutboundText("Pubky homeservers store public data under user keys; relays index it.", { env: {} }).clean,
    ).toBe(true);
  });
});

describe("scanOutboundText combines scrub rules with prompt_echo", () => {
  const KEY_ENV = { PUBKY_BOT_SECRET_KEY_HEX: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08" };

  it("reports secret rules alongside prompt_echo", () => {
    const text = `${systemPrompt().slice(0, 80)} ${KEY_ENV.PUBKY_BOT_SECRET_KEY_HEX}`;
    const rules = scanOutboundText(text, { env: KEY_ENV }).hits.map((h) => h.rule);
    expect(rules).toContain("prompt_echo");
    expect(rules).toContain("key_material");
  });

  it("passes the FP corpus (txid, digest, pubkey, git sha, RFC bearer, header name)", () => {
    const fps = [
      "txid: 4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b",
      "block 000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f",
      "sha256(hello world) = b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
      "pubkey 82341f882b6eabcd2ba7f1ef90aad961cf074af15b9ef44a09f9d2a8fbfbe6a2",
      "commit e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 on main",
      'the spec shows "Authorization: Bearer mF_9.B5f-4.1JqM" as an example',
      "the admin API expects an X-Admin-Password header on write routes",
    ];
    for (const fp of fps) expect(scanOutboundText(fp, { env: KEY_ENV }).clean).toBe(true);
  });

  it("assertOutboundClean throws rule ids only", () => {
    expect(() => assertOutboundClean(systemPrompt(), { env: {} })).toThrowError(/prompt_echo/);
    expect(() => assertOutboundClean("a normal reply", { env: {} })).not.toThrow();
  });
});
