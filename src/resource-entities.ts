import { normalize, occurrences } from "./resource-vocabulary.js";

export const RESOURCE_ENTITIES_VERSION = "resource-entities-v1";

export type ResourceEntityKind = "person" | "project" | "org" | "product";
export type ResourceEntity = {
  id: string;
  kind: ResourceEntityKind;
  aliases: readonly string[];
  shortId?: string;
};

export const slugifyPersonName = (name: string): string =>
  normalize(name).replaceAll(" ", "-");

const people = [
  ["adam-back", ["Adam Back", "adamback"]],
  ["pieter-wuille", ["Pieter Wuille", "sipa"]],
  ["gloria-zhao", ["Gloria Zhao", "glozow"]],
  ["matt-corallo", ["Matt Corallo", "TheBlueMatt"]],
  ["ruben-somsen", ["Ruben Somsen"]],
  ["jonas-nick", ["Jonas Nick"]],
  ["tim-ruffing", ["Tim Ruffing"]],
  ["anthony-towns", ["Anthony Towns", "ajtowns"]],
  ["greg-maxwell", ["Greg Maxwell", "gmaxwell", "nullc"]],
  ["andrew-poelstra", ["Andrew Poelstra", "apoelstra"]],
  ["olaoluwa-osuntokun", ["Olaoluwa Osuntokun", "roasbeef"]],
  ["rusty-russell", ["Rusty Russell"]],
  ["elizabeth-stark", ["Elizabeth Stark"]],
  ["joao-barbosa", ["Joao Barbosa", "fiatjaf"]],
  ["jack-dorsey", ["Jack Dorsey"]],
  ["satoshi-nakamoto", ["Satoshi Nakamoto"]],
  ["michael-flaxman", ["Michael Flaxman"]],
  ["jameson-lopp", ["Jameson Lopp", "lopp"]],
  ["eric-lombrozo", ["Eric Lombrozo"]],
  ["joseph-bono", ["Joseph Bono"]],
  ["thaddeus-dryja", ["Thaddeus Dryja", "Tadge Dryja"]],
  ["joseph-poon", ["Joseph Poon"]],
  ["robert-spycher", ["Robert Spycher"]],
  ["christian-decker", ["Christian Decker"]],
  ["rene-pickhardt", ["Rene Pickhardt"]],
  ["alex-bosworth", ["Alex Bosworth"]],
  ["robin-linus", ["Robin Linus"]],
  ["burak-keceli", ["Burak Keceli"]],
  ["antoine-riard", ["Antoine Riard"]],
  ["vincenzo-ampolo", ["Vincenzo Ampolo"]],
  ["pavol-rusnak", ["Pavol Rusnak"]],
  ["timo-hanke", ["Timo Hanke"]],
  ["mike-schmidt", ["Mike Schmidt"]],
  ["gustavo-f-echaiz", ["Gustavo Flores Echaiz"]],
  ["dusty-daemon", ["Dusty Daemon"]],
  ["armin-sabouri", ["Armin Sabouri"]],
  ["jeremy-rubin", ["Jeremy Rubin"]],
  ["john-athenasiou", ["John Athenasiou"]],
  ["matthew-trent", ["Matthew Trent"]],
  ["stephan-livera", ["Stephan Livera"]],
  ["nic-carter", ["Nic Carter"]],
  ["lyn-alden", ["Lyn Alden"]],
  ["parker-lewis", ["Parker Lewis"]],
  ["david-harding", ["David Harding"]],
  ["aaron-van-wirdum", ["Aaron van Wirdum"]],
  ["laurent-mt", ["Laurent MT"]],
  ["michael-folkson", ["Michael Folkson"]],
  ["erik-voorhees", ["Erik Voorhees"]],
  ["gabriele-di-bari", ["Gabriele Di Bari"]],
  ["caleb-madell", ["Caleb Madell"]],
  ["will-clark", ["Will Clark"]],
  ["daniel-geller", ["Daniel Geller"]],
  ["marty-bent", ["Marty Bent"]],
  ["matt-odell", ["Matt Odell", "Odell"]],
  ["david-chaum", ["David Chaum"]],
  ["hal-finney", ["Hal Finney"]],
  ["len-sassaman", ["Len Sassaman"]],
  ["wei-dai", ["Wei Dai"]],
  ["nick-szabo", ["Nick Szabo"]],
  ["ross-stevens", ["Ross Stevens"]],
  ["jack-mallers", ["Jack Mallers"]],
  ["steve-lee", ["Steve Lee"]],
  ["peter-todd", ["Peter Todd"]],
  ["jon-atack", ["Jon Atack"]],
  ["mark-erhardt", ["Mark Erhardt", "Murch"]],
] as const;

const named = [
  ["bitcoin-core", "project"], ["lnd", "project"], ["core-lightning", "project"], ["eclair", "project"],
  ["ldk", "project"], ["btcpay", "project"], ["electrum", "project"], ["sparrow", "product"],
  ["bisq", "project"], ["wasabi", "product"], ["samourai", "project"], ["mempool-space", "product"],
  ["blockstream", "org"], ["optech", "org"], ["chaincode", "org"], ["spiral", "org"],
  ["brink", "org"], ["lightning-labs", "org"], ["acinq", "org"], ["coldcard", "product"],
  ["trezor", "product"], ["ledger", "product"], ["bitbox", "product"], ["jade", "product"],
  ["liquid", "project"], ["fedimint", "project"], ["cashu", "project"], ["ark", "project"],
  ["nostr", "project"], ["damus", "product"], ["primal", "product"], ["amethyst", "product"],
  ["pubky", "project"], ["synonym", "org"], ["bitkit", "product"], ["tether", "org"],
  ["strike", "product"], ["river", "org"], ["swan", "org"], ["bitrefill", "product"],
  ["stacker-news", "product"], ["bitcoin-dev", "org"], ["lightning-dev", "org"], ["nostr-dev", "org"],
  ["bips", "org"], ["bolt", "project"], ["elements", "project"], ["rust-bitcoin", "project"],
  ["rust-lightning", "project"], ["libsecp256k1", "project"], ["secp256k1", "project"],
  ["ndk", "project"], ["nostr-tools", "project"], ["iris", "product"], ["ndk-mobile", "project"],
  ["ndb", "project"], ["zaprite", "product"], ["vss", "project"],
  ["homegate", "product"], ["nexus", "product"], ["ring", "product"], ["pkarr", "project"],
] as const;

const PERSON_SHORT_IDS = {
  "gustavo-f-echaiz": "gustavo-f-echaiz",
} as const;

const NAMED_ALIASES: Record<string, readonly string[]> = {
  eclair: ["acinq eclair", "eclair lightning"],
  sparrow: ["sparrow wallet"],
  ledger: ["ledger nano", "ledger wallet"],
  jade: ["blockstream jade", "products jade"],
  ark: ["ark protocol", "ark labs"],
  primal: ["primal app", "primal nostr"],
  strike: ["strike app", "strike payments"],
  river: ["river financial"],
  swan: ["swan bitcoin"],
  bolt: ["bolt card"],
  elements: ["elements sidechain", "liquid elements"],
  liquid: ["liquid network"],
  iris: [],
  ring: ["pubky ring"],
};

export const RESOURCE_ENTITIES: readonly ResourceEntity[] = [
  ...people.map(([id, aliases]) => {
    const shortId = PERSON_SHORT_IDS[id as keyof typeof PERSON_SHORT_IDS];
    return { id, kind: "person" as const, aliases, ...(shortId ? { shortId } : {}) };
  }),
  ...named.map(([id, kind]) => ({
    id,
    kind: kind as ResourceEntityKind,
    aliases: NAMED_ALIASES[id] ?? [id.replaceAll("-", " "), id],
  })),
];

export function matchResourceEntities(
  fields: { title?: string; description?: string; url?: string; site_name?: string },
  entities: readonly ResourceEntity[] = RESOURCE_ENTITIES,
): readonly ResourceEntity[] {
  const values = [fields.title?.slice(0, 512), fields.description?.slice(0, 4096), fields.site_name?.slice(0, 256), fields.url ? new URL(fields.url).pathname.slice(0, 512) : undefined]
    .filter((value): value is string => Boolean(value)).map(normalize);
  return entities.filter((entity) => entity.aliases.some((alias) => values.some((value) => occurrences(value, alias) > 0)));
}
