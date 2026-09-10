import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { AuthFlow, AuthFlowKind, Pubky, Signer } from "@synonymdev/pubky";
import {
  assertSessionAuthority,
  evaluateCapabilities,
  openScopedSession,
  openProductionScopedTransport,
  openScopedTransport,
  ScopedSessionError,
  ScopedSessionTransport,
  sdkScopedAuthPort,
  type ScopedAuthFlow,
  type ScopedAuthPort,
  type ScopedSession,
  type ScopedSessionFailure,
} from "./resource-scoped-session.js";
import {
  PRODUCTION_RESOURCE_PROFILE,
  PUBKYAUTH_RELAY_URL,
  STAGING_RESOURCE_PROFILE,
} from "./resource-target-profile.js";

const SCOPE = STAGING_RESOURCE_PROFILE.tagCapabilityScope;
/** A shape that would be obviously fatal if it ever reached a sink. */
const SENTINEL_URL = "pubkyauth:///?relay=SENTINEL-AUTH-URL-9d2f&secret=SENTINEL-CHANNEL-SECRET";

interface FakeSessionOptions {
  publisherPk?: string;
  capabilities?: string[];
  uninspectable?: boolean;
  signoutThrows?: boolean;
}

class FakeSession implements ScopedSession {
  signouts = 0;
  readonly puts: Array<{ path: string; json: unknown }> = [];
  readonly deletes: string[] = [];
  private readonly listings: string[][];

  constructor(
    private readonly options: FakeSessionOptions = {},
    listings: string[][] = [[]],
  ) {
    this.listings = listings;
  }

  get info(): { readonly publicKey: { z32(): string }; readonly capabilities: string[] } {
    if (this.options.uninspectable) throw new Error("session info unavailable");
    const publisherPk = this.options.publisherPk ?? STAGING_RESOURCE_PROFILE.publisherPk;
    return { publicKey: { z32: () => publisherPk }, capabilities: this.options.capabilities ?? [`${SCOPE}:rw`] };
  }

  get storage() {
    return {
      putJson: async (path: string, json: unknown) => {
        this.puts.push({ path, json });
      },
      getJson: async (path: string) => ({ path }),
      delete: async (path: string) => {
        this.deletes.push(path);
      },
      list: async () => this.listings.shift() ?? [],
    };
  }

  async signout(): Promise<void> {
    this.signouts += 1;
    if (this.options.signoutThrows) throw new Error("signout failed");
  }
}

interface FakePortOptions {
  session?: FakeSession;
  authorizationUrl?: string;
  startThrows?: boolean;
  approveThrows?: Error;
  approvalRejects?: Error;
  approvalDelayMs?: number;
  homeserverPk?: string;
}

class FakePort implements ScopedAuthPort {
  readonly starts: Array<{ capabilities: string; relay: string }> = [];
  readonly approved: string[] = [];
  session: FakeSession;

  constructor(private readonly options: FakePortOptions = {}) {
    this.session = options.session ?? new FakeSession();
  }

  startSigninFlow(capabilities: string, relay: string): ScopedAuthFlow {
    if (this.options.startThrows) throw new Error("relay URL rejected");
    this.starts.push({ capabilities, relay });
    const options = this.options;
    const session = this.session;
    return {
      authorizationUrl: options.authorizationUrl ?? SENTINEL_URL,
      awaitApproval: () =>
        new Promise<ScopedSession>((resolve, reject) => {
          const settle = () => (options.approvalRejects ? reject(options.approvalRejects) : resolve(session));
          if (options.approvalDelayMs) setTimeout(settle, options.approvalDelayMs);
          else settle();
        }),
    };
  }

  async approve(authorizationUrl: string): Promise<void> {
    if (this.options.approveThrows) throw this.options.approveThrows;
    this.approved.push(authorizationUrl);
  }

  async resolveHomeserverPk(): Promise<string | undefined> {
    return this.options.homeserverPk ?? STAGING_RESOURCE_PROFILE.homeserverPk;
  }
}

function named(name: string, message = "sdk failure"): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

async function failureCode(promise: Promise<unknown>): Promise<ScopedSessionFailure> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ScopedSessionError);
    return (error as ScopedSessionError).code;
  }
  throw new Error("expected the scoped session to be refused");
}

describe("installed SDK still exposes the scoped self-approval flow", () => {
  it("has the symbols the port adapter binds to", () => {
    expect(typeof Pubky.prototype.startAuthFlow).toBe("function");
    expect(typeof AuthFlowKind.signin).toBe("function");
    expect(typeof AuthFlow.prototype.awaitApproval).toBe("function");
    expect(typeof Signer.prototype.approveAuthRequest).toBe("function");
    // `authorizationUrl` is a readonly property, not a method: reading it as a
    // function would hand the signer `undefined`.
    const descriptor = Object.getOwnPropertyDescriptor(AuthFlow.prototype, "authorizationUrl");
    expect(descriptor?.get).toBeTypeOf("function");
    expect(descriptor?.value).toBeUndefined();
    expect(typeof sdkScopedAuthPort).toBe("function");
  });

  it("still documents root capabilities on the signin path the resources role must never use", () => {
    expect(typeof Signer.prototype.signin).toBe("function");
    // The scoped module must not reference the root signin path at all.
    expect(ScopedSessionTransport.prototype).not.toHaveProperty("signin");
  });
});

describe("capability coverage plus maximum-authority bound", () => {
  it("accepts the exact scope with both actions", () => {
    expect(evaluateCapabilities([`${SCOPE}:rw`], SCOPE)).toEqual({ ok: true, actions: "rw" });
  });

  it("accepts a split read and write grant whose union is the exact scope", () => {
    expect(evaluateCapabilities([`${SCOPE}:r`, `${SCOPE}:w`], SCOPE)).toEqual({ ok: true, actions: "rw" });
  });

  it("normalizes action order", () => {
    expect(evaluateCapabilities([`${SCOPE}:wr`], SCOPE)).toEqual({ ok: true, actions: "rw" });
  });

  it.each<[string, string[], ScopedSessionFailure]>([
    ["root", ["/:rw"], "capability_too_broad"],
    ["parent app", ["/pub/jeb.pubky.app/:rw"], "capability_too_broad"],
    ["all public", ["/pub/:rw"], "capability_too_broad"],
    ["read only", [`${SCOPE}:r`], "capability_not_covered"],
    ["write only", [`${SCOPE}:w`], "capability_not_covered"],
    ["empty grant set", [], "capability_not_covered"],
    ["narrower single file", [`${SCOPE}abc:rw`], "capability_extra_grant"],
    ["extra grant inside the subtree", [`${SCOPE}:rw`, `${SCOPE}abc:r`], "capability_extra_grant"],
    ["sibling app", [`${SCOPE}:rw`, "/pub/pubky.app/tags/:rw"], "capability_out_of_scope"],
    ["sibling directory", [`${SCOPE}:rw`, "/pub/jeb.pubky.app/posts/:rw"], "capability_out_of_scope"],
    ["private path", [`${SCOPE}:rw`, "/priv/notes.txt:r"], "capability_out_of_scope"],
    ["look-alike app prefix", ["/pub/jeb.pubky.application/tags/:rw"], "capability_out_of_scope"],
    ["forbidden action", [`${SCOPE}:rwx`], "capability_malformed"],
    ["unknown action", [`${SCOPE}:x`], "capability_action_forbidden"],
    ["missing actions", [`${SCOPE}:`], "capability_malformed"],
    ["missing colon", [SCOPE], "capability_malformed"],
    ["relative scope", ["pub/jeb.pubky.app/tags/:rw"], "capability_malformed"],
    ["traversal scope", ["/pub/jeb.pubky.app/tags/../posts/:rw"], "capability_malformed"],
    ["duplicated action", [`${SCOPE}:rr`], "capability_malformed"],
    ["duplicate normalized grant", [`${SCOPE}:rw`, `${SCOPE}:wr`], "capability_duplicate_grant"],
  ])("refuses %s", (_label, grants, code) => {
    expect(evaluateCapabilities(grants, SCOPE)).toEqual({ ok: false, code });
  });

  it("refuses to evaluate a required scope that is not a directory", () => {
    expect(evaluateCapabilities([`${SCOPE}:rw`], "/pub/jeb.pubky.app/tags")).toEqual({
      ok: false,
      code: "capability_malformed",
    });
  });
});

describe("scoped session authority assertion", () => {
  it("accepts the pinned publisher with the exact grant", () => {
    expect(() => assertSessionAuthority(new FakeSession(), STAGING_RESOURCE_PROFILE)).not.toThrow();
  });

  it("refuses a session for another identity", () => {
    const session = new FakeSession({ publisherPk: PRODUCTION_RESOURCE_PROFILE.publisherPk });
    expect(() => assertSessionAuthority(session, STAGING_RESOURCE_PROFILE)).toThrow(/publisher_mismatch/);
  });

  it("refuses a session whose capabilities cannot be inspected", () => {
    expect(() => assertSessionAuthority(new FakeSession({ uninspectable: true }), STAGING_RESOURCE_PROFILE)).toThrow(
      /session_uninspectable/,
    );
  });
});

describe("openScopedSession", () => {
  it("requests exactly the tag scope over the pinned relay and returns the publisher session", async () => {
    const port = new FakePort();
    const session = await openScopedSession({ port, profile: STAGING_RESOURCE_PROFILE, approvalTimeoutMs: 1_000 });
    expect(port.starts).toEqual([{ capabilities: `${SCOPE}:rw`, relay: PUBKYAUTH_RELAY_URL }]);
    expect(port.approved).toEqual([SENTINEL_URL]);
    expect(session.info.publicKey.z32()).toBe(STAGING_RESOURCE_PROFILE.publisherPk);
    expect((session as FakeSession).signouts).toBe(0);
  });

  it("requests the production tag scope for the production profile", async () => {
    const port = new FakePort({
      session: new FakeSession({ publisherPk: PRODUCTION_RESOURCE_PROFILE.publisherPk }),
    });
    await openScopedSession({ port, profile: PRODUCTION_RESOURCE_PROFILE, approvalTimeoutMs: 1_000 });
    expect(port.starts[0]!.capabilities).toBe(`${PRODUCTION_RESOURCE_PROFILE.tagCapabilityScope}:rw`);
  });

  it("signs out and refuses a relay-granted root capability", async () => {
    const session = new FakeSession({ capabilities: ["/:rw"] });
    const port = new FakePort({ session });
    expect(
      await failureCode(openScopedSession({ port, profile: STAGING_RESOURCE_PROFILE, approvalTimeoutMs: 1_000 })),
    ).toBe("capability_too_broad");
    expect(session.signouts).toBe(1);
  });

  it("signs out and refuses an extra grant beside the correct one", async () => {
    const session = new FakeSession({ capabilities: [`${SCOPE}:rw`, "/pub/pubky.app/tags/:rw"] });
    const port = new FakePort({ session });
    expect(
      await failureCode(openScopedSession({ port, profile: STAGING_RESOURCE_PROFILE, approvalTimeoutMs: 1_000 })),
    ).toBe("capability_out_of_scope");
    expect(session.signouts).toBe(1);
  });

  it("signs out and refuses a session minted for the wrong identity", async () => {
    const session = new FakeSession({ publisherPk: PRODUCTION_RESOURCE_PROFILE.publisherPk });
    const port = new FakePort({ session });
    expect(
      await failureCode(openScopedSession({ port, profile: STAGING_RESOURCE_PROFILE, approvalTimeoutMs: 1_000 })),
    ).toBe("publisher_mismatch");
    expect(session.signouts).toBe(1);
  });

  it("still refuses when sign-out itself fails", async () => {
    const session = new FakeSession({ capabilities: ["/:rw"], signoutThrows: true });
    const port = new FakePort({ session });
    expect(
      await failureCode(openScopedSession({ port, profile: STAGING_RESOURCE_PROFILE, approvalTimeoutMs: 1_000 })),
    ).toBe("capability_too_broad");
    expect(session.signouts).toBe(1);
  });

  it("maps a denied approval to a bounded code", async () => {
    const port = new FakePort({ approvalRejects: named("AuthenticationError", "approval denied for channel") });
    expect(
      await failureCode(openScopedSession({ port, profile: STAGING_RESOURCE_PROFILE, approvalTimeoutMs: 1_000 })),
    ).toBe("approval_denied");
  });

  it("maps a relay transport failure to a bounded code", async () => {
    const port = new FakePort({ approvalRejects: named("RequestError", "relay 503") });
    expect(
      await failureCode(openScopedSession({ port, profile: STAGING_RESOURCE_PROFILE, approvalTimeoutMs: 1_000 })),
    ).toBe("approval_transport_failed");
  });

  it("maps a failed self-approval to a bounded code without awaiting forever", async () => {
    const port = new FakePort({ approveThrows: named("RequestError", "post to relay failed"), approvalDelayMs: 50 });
    expect(
      await failureCode(openScopedSession({ port, profile: STAGING_RESOURCE_PROFILE, approvalTimeoutMs: 5_000 })),
    ).toBe("approval_transport_failed");
  });

  it("refuses an empty authorization URL before approving anything", async () => {
    const port = new FakePort({ authorizationUrl: "" });
    expect(
      await failureCode(openScopedSession({ port, profile: STAGING_RESOURCE_PROFILE, approvalTimeoutMs: 1_000 })),
    ).toBe("authorization_url_missing");
    expect(port.approved).toEqual([]);
  });

  it("refuses when the flow cannot be started", async () => {
    const port = new FakePort({ startThrows: true });
    expect(
      await failureCode(openScopedSession({ port, profile: STAGING_RESOURCE_PROFILE, approvalTimeoutMs: 1_000 })),
    ).toBe("auth_flow_start_failed");
  });

  // Deliberate negative for P3-c: awaitApproval() takes no timeout, so the
  // deadline is the only thing bounding it.
  it("times out an approval that never arrives and never falls back to root signin", async () => {
    const port = new FakePort({ approvalDelayMs: 10_000 });
    expect(await failureCode(openScopedSession({ port, profile: STAGING_RESOURCE_PROFILE, approvalTimeoutMs: 15 }))).toBe(
      "approval_timeout",
    );
    expect(port.session.puts).toEqual([]);
  });

  it("signs out a session that arrives after the deadline", async () => {
    const port = new FakePort({ approvalDelayMs: 25 });
    expect(await failureCode(openScopedSession({ port, profile: STAGING_RESOURCE_PROFILE, approvalTimeoutMs: 5 }))).toBe(
      "approval_timeout",
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(port.session.signouts).toBe(1);
    expect(port.session.puts).toEqual([]);
  });

  it("absorbs an approval rejection that arrives after the deadline", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      const port = new FakePort({ approvalDelayMs: 25, approvalRejects: named("RequestError", "late relay failure") });
      expect(
        await failureCode(openScopedSession({ port, profile: STAGING_RESOURCE_PROFILE, approvalTimeoutMs: 5 })),
      ).toBe("approval_timeout");
      await new Promise((resolve) => setTimeout(resolve, 60));
    } finally {
      process.off("unhandledRejection", onRejection);
    }
    expect(rejections).toEqual([]);
  });

  it("refuses a non-positive approval deadline", async () => {
    const port = new FakePort();
    expect(await failureCode(openScopedSession({ port, profile: STAGING_RESOURCE_PROFILE, approvalTimeoutMs: 0 }))).toBe(
      "approval_timeout",
    );
  });
});

describe("authorization URL never reaches a sink", () => {
  it("keeps the sentinel out of stdout, stderr, thrown errors, and the transport", async () => {
    const written: string[] = [];
    const realOut = process.stdout.write.bind(process.stdout);
    const realErr = process.stderr.write.bind(process.stderr);
    const capture = (chunk: unknown) => {
      written.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    };
    process.stdout.write = capture as typeof process.stdout.write;
    process.stderr.write = capture as typeof process.stderr.write;
    let thrown: unknown;
    let serializedTransport = "";
    try {
      const ok = new FakePort();
      const transport = await openScopedTransport({
        port: ok,
        profile: STAGING_RESOURCE_PROFILE,
        approvalTimeoutMs: 1_000,
      });
      serializedTransport = JSON.stringify(transport, (_key, value) => (value instanceof Map ? [...value] : value));
      const broad = new FakePort({ session: new FakeSession({ capabilities: ["/:rw"] }) });
      try {
        await openScopedSession({ port: broad, profile: STAGING_RESOURCE_PROFILE, approvalTimeoutMs: 1_000 });
      } catch (error) {
        thrown = error;
      }
    } finally {
      process.stdout.write = realOut;
      process.stderr.write = realErr;
    }
    const haystack = [
      written.join(""),
      serializedTransport,
      String(thrown),
      (thrown as Error).stack ?? "",
      JSON.stringify(thrown, Object.getOwnPropertyNames(thrown)),
    ].join("\n");
    // Serializing the transport can only ever emit bounded public identifiers.
    expect(Object.keys(JSON.parse(serializedTransport) as object).sort()).toEqual(["botPk", "resolvedHomeserverPk"]);
    expect(haystack).not.toContain("SENTINEL-AUTH-URL-9d2f");
    expect(haystack).not.toContain("SENTINEL-CHANNEL-SECRET");
    expect(haystack).not.toContain("pubkyauth://");
    // The refusal itself is still legible.
    expect(String(thrown)).toContain("capability_too_broad");
  });
});

describe("ScopedSessionTransport", () => {
  const opts = (port: ScopedAuthPort) => ({ port, profile: STAGING_RESOURCE_PROFILE, approvalTimeoutMs: 1_000 });

  it("carries the pinned publisher and resolved homeserver", async () => {
    const port = new FakePort();
    const transport = await openScopedTransport(opts(port));
    expect(transport.botPk).toBe(STAGING_RESOURCE_PROFILE.publisherPk);
    expect(transport.resolvedHomeserverPk).toBe(STAGING_RESOURCE_PROFILE.homeserverPk);
  });

  it("performs tag writes, reads, deletes, and owned listings", async () => {
    const listings = [[`pubky://${STAGING_RESOURCE_PROFILE.publisherPk}${SCOPE}abc`], []];
    const port = new FakePort({ session: new FakeSession({}, listings) });
    const transport = await openScopedTransport(opts(port));
    await transport.putJson(`${SCOPE}abc`, { uri: "https://example.com" });
    await transport.deleteJson(`${SCOPE}abc`);
    expect(port.session.puts).toEqual([{ path: `${SCOPE}abc`, json: { uri: "https://example.com" } }]);
    expect(port.session.deletes).toEqual([`${SCOPE}abc`]);
    await expect(transport.listJsonPaths(SCOPE)).resolves.toEqual([`${SCOPE}abc`]);
  });

  it("refuses a listing that contains another identity's path", async () => {
    const listings = [[`pubky://${PRODUCTION_RESOURCE_PROFILE.publisherPk}${SCOPE}abc`]];
    const port = new FakePort({ session: new FakeSession({}, listings) });
    const transport = await openScopedTransport(opts(port));
    await expect(transport.listJsonPaths(SCOPE)).rejects.toThrow(/another identity/);
  });

  it("refuses operations the scoped session has no authority for", async () => {
    const port = new FakePort();
    const transport = await openScopedTransport(opts(port));
    await expect(transport.putBytes("/pub/jeb.pubky.app/files/x", new Uint8Array([1]))).rejects.toThrow(
      /not_authorized_for_bytes/,
    );
    await expect(transport.listPosts()).rejects.toThrow(/not_authorized_for_posts/);
  });

  it("re-mints the same scoped session on reauth and signs the old one out", async () => {
    const port = new FakePort();
    const transport = await openScopedTransport(opts(port));
    const first = port.session;
    port.session = new FakeSession();
    await transport.reauth();
    expect(port.starts.map((start) => start.capabilities)).toEqual([`${SCOPE}:rw`, `${SCOPE}:rw`]);
    expect(first.signouts).toBe(1);
    await transport.putJson(`${SCOPE}abc`, { uri: "https://example.com" });
    expect(port.session.puts).toHaveLength(1);
    expect(first.puts).toHaveLength(0);
  });

  // Deliberate negative: a reauth that comes back broader must not become the
  // transport's session, and there is no root fallback behind it.
  it("refuses a reauth that returns a broader grant and keeps the old session unused", async () => {
    const port = new FakePort();
    const transport = await openScopedTransport(opts(port));
    const first = port.session;
    const broader = new FakeSession({ capabilities: ["/:rw"] });
    port.session = broader;
    expect(await failureCode(transport.reauth())).toBe("capability_too_broad");
    expect(broader.signouts).toBe(1);
    await transport.putJson(`${SCOPE}abc`, { uri: "https://example.com" });
    expect(broader.puts).toHaveLength(0);
    expect(first.puts).toHaveLength(1);
  });
});

describe("every terminal path signs out", () => {
  const opts = (port: ScopedAuthPort) => ({ port, profile: STAGING_RESOURCE_PROFILE, approvalTimeoutMs: 1_000 });

  // A PKDNS failure after the session was minted must not strand it.
  it("signs out the new session when homeserver resolution fails", async () => {
    class PkdnsFailingPort extends FakePort {
      override async resolveHomeserverPk(): Promise<string | undefined> {
        throw new Error("pkarr relay unreachable");
      }
    }
    const port = new PkdnsFailingPort();
    await expect(openScopedTransport(opts(port))).rejects.toThrow();
    expect(port.session.signouts).toBe(1);
  });

  it("signs out on the success path when the transport closes", async () => {
    const port = new FakePort();
    const transport = await openScopedTransport(opts(port));
    expect(port.session.signouts).toBe(0);
    await transport.close();
    expect(port.session.signouts).toBe(1);
  });

  it("signs out a session that arrives after the approval timeout even when sign-out fails", async () => {
    const session = new FakeSession({ signoutThrows: true });
    const port = new FakePort({ session, approvalDelayMs: 25 });
    expect(await failureCode(openScopedSession({ port, profile: STAGING_RESOURCE_PROFILE, approvalTimeoutMs: 5 }))).toBe(
      "approval_timeout",
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(session.signouts).toBe(1);
  });

  // The key is loaded at the single use site: the production entry point
  // reads the environment when no hex is passed, and never a config field.
  it("loads the secret from the environment at the use site", async () => {
    const saved = process.env.PUBKY_BOT_SECRET_KEY_HEX;
    process.env.PUBKY_BOT_SECRET_KEY_HEX = "11".repeat(32);
    try {
      await expect(
        openProductionScopedTransport({ profile: PRODUCTION_RESOURCE_PROFILE, testnet: false }),
      ).rejects.toMatchObject({ code: "publisher_mismatch" });
    } finally {
      if (saved === undefined) delete process.env.PUBKY_BOT_SECRET_KEY_HEX;
      else process.env.PUBKY_BOT_SECRET_KEY_HEX = saved;
    }
  });
});

describe("the resources role has no root-session path to production", () => {
  it("refuses a derived key that is not the profile publisher, before any auth flow", async () => {
    await expect(
      openProductionScopedTransport({
        secretKeyHex: "11".repeat(32),
        profile: PRODUCTION_RESOURCE_PROFILE,
        testnet: false,
      }),
    ).rejects.toMatchObject({ code: "publisher_mismatch" });
  });

  it("refuses a malformed secret before constructing a keypair", async () => {
    await expect(
      openProductionScopedTransport({ secretKeyHex: "beef", profile: PRODUCTION_RESOURCE_PROFILE, testnet: false }),
    ).rejects.toMatchObject({ code: "auth_flow_start_failed" });
  });

  // Guard test: the production branch of the CLI must not be able to reach
  // the root `signin()` transport, whatever else changes in that function.
  it("never mentions the root transport on the production branch", async () => {
    const source = await readFile(new URL("./resources.ts", import.meta.url), "utf8");
    const branch = source.slice(source.indexOf("transport ="), source.indexOf("const expectedPublisherPk ="));
    expect(branch).toContain("openProductionScopedTransport");
    const productionArm = branch.slice(branch.indexOf("? await"), branch.indexOf(": await"));
    expect(productionArm).not.toContain("openTransport");
    expect(productionArm).not.toContain("signupToken");
  });
});
