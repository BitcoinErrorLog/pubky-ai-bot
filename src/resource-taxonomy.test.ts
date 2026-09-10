import { describe, expect, it } from "vitest";
import { validateTaxonomy } from "./resource-taxonomy.js";

describe("legal taxonomy", () => {
  it("accepts each supported legal document type", () => {
    for (const type of ["regulation", "proposed-rule", "notice", "presidential-document", "filing"]) {
      expect(validateTaxonomy({ domain: ["legal"], type: [type], subject: [], geography: [], sourceStatus: [] })).toBeNull();
    }
  });

  it("rejects an unsupported legal document type", () => {
    expect(validateTaxonomy({ domain: ["legal"], type: ["article"], subject: [], geography: [], sourceStatus: [] })).toBe("legal domain requires legal type");
  });
});
