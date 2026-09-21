/**
 * The only allowlist for person names as resource labels.
 *
 * `aboutLabels`: a person's name may be published as a label only when it is
 * listed here AND the name appears in the resource title (the resource is
 * about the person, not merely by them or quoting them).
 *
 * `notPeople`: name-shaped labels that are organisations, products, or
 * software. The person gate never drops these.
 *
 * Bump the version whenever either list changes; it is recorded in every
 * manifest next to the drop reasons.
 */
export const PERSON_GAZETTEER_VERSION = "person-gazetteer-v1";

export const PERSON_GAZETTEER_ABOUT_LABELS: ReadonlySet<string> = new Set([
  "satoshi-nakamoto",
]);

export const PERSON_GAZETTEER_NOT_PEOPLE: ReadonlySet<string> = new Set([
  "morgan-stanley",
  "goldman-sachs",
  "jp-morgan",
  "jpmorgan-chase",
  "wells-fargo",
  "berkshire-hathaway",
  "john-the-ripper",
  "bitcoin-magazine",
  "stacker-news",
  "the-block",
  "the-rage",
  "bitcoin-optech",
  "delving-bitcoin",
  "bnp-paribas",
  "td-cowen",
  "sp-global",
  "chaincode-labs",
  "lightning-labs",
]);
