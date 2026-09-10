import { afterEach, describe, expect, it, vi } from "vitest";

const getHomeserver = vi.fn(async () => {
  throw new Error("pkarr relay timeout");
});

vi.mock("@synonymdev/pubky", () => ({
  Keypair: {
    fromSecret: (raw: Uint8Array) => {
      if (raw.length !== 32) throw new Error("secret must be 32 bytes");
      return { publicKey: { z32: () => "botpkabcdefghijklmnopqrstuvwxyzabcdefghijklmnopq" } };
    },
  },
  Pubky: class {
    static testnet() {
      return new this();
    }
    signer() {
      return {
        signin: async () => ({ storage: {} }),
        signup: async () => ({ storage: {} }),
        pkdns: { getHomeserver },
      };
    }
  },
  PublicKey: { from: (pk: string) => pk },
}));

import { log } from "./log.js";
import { openTransport } from "./homeserver.js";

const SECRET = "aa".repeat(32);

describe("openTransport getHomeserver failures", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    getHomeserver.mockReset();
    getHomeserver.mockImplementation(async () => {
      throw new Error("pkarr relay timeout");
    });
  });

  it("succeeds when getHomeserver rejects and leaves resolvedHomeserverPk undefined", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => log);
    const relayUrl = "https://relay.example/pkarr/9o6xrx8wgqu48dmb47uep6w3dgbwdnf5jgw83gbeuxg9yi7x444y";
    getHomeserver.mockRejectedValue(Object.assign(new Error(`pkarr relay timeout: ${relayUrl}`), { name: "PkarrError" }));
    const t = await openTransport({
      secretKeyHex: SECRET,
      homeserverPk: "homeserverpk",
      testnet: false,
    });
    expect(t.resolvedHomeserverPk).toBeUndefined();
    expect(t.botPk).toBe("botpkabcdefghijklmnopqrstuvwxyzabcdefghijklmnopq");
    expect(warn).toHaveBeenCalled();
    const [fields, msg] = warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(msg).toMatch(/getHomeserver failed/);
    expect(fields.errClass).toBe("PkarrError");
    // Class only: a pkarr error message carries the relay URL and the queried
    // identity, and this line goes to the shared log.
    expect(fields.errMessage).toBeUndefined();
    const logged = JSON.stringify(warn.mock.calls[0]);
    expect(logged).not.toContain(relayUrl);
    expect(logged).not.toContain("relay.example");
    expect(logged).not.toMatch(/aa{8,}/);
  });
});
