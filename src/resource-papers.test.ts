import { describe, expect, it, vi } from "vitest";
import { canonicalPaperUrl, discoverPapers, parseArxivAtom, parseCrossrefJson, parseIacrRss } from "./resource-papers.js";

const atom = `<?xml version="1.0"?><feed><entry><id>https://arxiv.org/abs/2401.12345v2</id><title>Bitcoin Security</title><summary>Research abstract</summary><category term="cs.CR"/></entry></feed>`;
const rss = `<?xml version="1.0"?><rss><channel><item><title>Cryptographic Bitcoin</title><link>https://eprint.iacr.org/2026/123</link><description>Paper abstract</description></item></channel></rss>`;
const crossref = JSON.stringify({ message: { items: [{ DOI: "10.1000/bitcoin.1", title: ["Bitcoin economics"], abstract: "<p>Research</p>", subject: ["Economics"] }] } });

describe("papers adapter", () => {
  it("parses the three approved metadata formats and canonicalizes identities", () => {
    expect(parseArxivAtom(atom)[0]).toMatchObject({ source: "arxiv" });
    expect(parseIacrRss(rss)[0]).toMatchObject({ source: "iacr-eprint" });
    expect(parseCrossrefJson(crossref)[0]).toMatchObject({ source: "crossref", doi: "10.1000/bitcoin.1" });
    expect(canonicalPaperUrl({ url: "https://arxiv.org/abs/2401.12345v2" })).toBe("https://arxiv.org/abs/2401.12345");
    expect(canonicalPaperUrl({ url: "https://eprint.iacr.org/2026/123" })).toBe("https://eprint.iacr.org/2026/123");
  });

  it.each(["", "<!DOCTYPE feed><feed/>", "<feed><entry>", JSON.stringify({ message: { items: [] } })])(
    "rejects malformed or empty source data",
    (value) => expect(() => parseArxivAtom(value)).toThrow(),
  );

  it("fails closed on a source outage and preserves the halt", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("eprint")) return new Response("unavailable", { status: 503 });
      if (url.includes("crossref")) return new Response(crossref, { headers: { "content-type": "application/json" } });
      return new Response(atom, { headers: { "content-type": "application/atom+xml" } });
    }) as unknown as typeof fetch;
    const run = await discoverPapers({ limit: 10, contactEmail: "contact@example.org", fetchImpl, sleep: async () => {} });
    expect(run.shadowReport.halt).toMatchObject({ reason: "source-unavailable", subSources: ["iacr-eprint"] });
    expect(run.accepted).toHaveLength(2);
  });

  it("rejects a request limit over the hard ceiling before fetching", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(discoverPapers({ limit: 101, contactEmail: "contact@example.org", fetchImpl })).rejects.toThrow("request budget");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
