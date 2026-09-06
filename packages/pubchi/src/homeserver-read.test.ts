import { describe, expect, it } from "vitest";
import { wrapReaderTimeout, type PublicHomeserverReader } from "./homeserver-read.js";

describe("homeserver public getJson timeout", () => {
  it("aborts a hung public getJson after the timeout", async () => {
    const hung: PublicHomeserverReader = {
      getJson: () => new Promise(() => {}),
    };
    const reader = wrapReaderTimeout(hung, 40);
    await expect(reader.getJson("pubky://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/pub/x.json")).rejects.toThrow(
      /homeserver_timeout/,
    );
  });
});
