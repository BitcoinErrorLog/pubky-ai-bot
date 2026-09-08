export const VOCABULARY_VERSION = "resource-subjects-v1";

export type SubjectDomain = "bitcoin" | "lightning" | "cryptography" | "general-tech" | "nostr" | "privacy" | "security";

export type ResourceSubject = {
  id: string;
  domain: readonly SubjectDomain[];
  aliases: readonly string[];
};

const ids = [
  ["consensus", ["bitcoin"], ["consensus rules", "consensus"]],
  ["soft-fork", ["bitcoin"], ["soft fork", "soft-fork"]],
  ["covenants", ["bitcoin"], ["covenant", "covenants"]],
  ["ctv", ["bitcoin"], ["check template verify", "ctv"]],
  ["op-cat", ["bitcoin"], ["op cat", "opcode cat"]],
  ["taproot", ["bitcoin"], ["taproot", "tap root"]],
  ["schnorr", ["bitcoin", "cryptography"], ["schnorr signature", "schnorr"]],
  ["musig", ["bitcoin", "cryptography"], ["mu sig", "musig"]],
  ["frost", ["bitcoin", "cryptography"], ["frost signature", "frost"]],
  ["signatures", ["bitcoin", "cryptography"], ["digital signatures", "signatures"]],
  ["hash-signatures", ["cryptography"], ["hash based signatures", "hash-based signatures", "slh dsa", "slh-dsa", "stateful hash"]],
  ["post-quantum", ["bitcoin", "cryptography"], ["post quantum", "post-quantum", "pqc", "quantum resistant", "quantum-safe", "quantum signatures"]],
  ["privacy", ["bitcoin", "privacy"], ["bitcoin privacy", "privacy"]],
  ["payjoin", ["bitcoin", "privacy"], ["payjoin", "pay join"]],
  ["silent-payments", ["bitcoin", "privacy"], ["silent payments", "silent-payment"]],
  ["coinjoin", ["bitcoin", "privacy"], ["coinjoin", "coin join"]],
  ["fingerprinting", ["bitcoin", "privacy"], ["wallet fingerprinting", "fingerprinting", "fingerprints"]],
  ["mempool", ["bitcoin"], ["mempool", "memory pool"]],
  ["fees", ["bitcoin"], ["transaction fees", "fees"]],
  ["rbf", ["bitcoin"], ["replace by fee", "rbf"]],
  ["cpfp", ["bitcoin"], ["child pays for parent", "cpfp"]],
  ["package-relay", ["bitcoin"], ["package relay", "package-relay"]],
  ["mining", ["bitcoin"], ["bitcoin mining", "mining"]],
  ["pooling", ["bitcoin"], ["mining pool", "pooling"]],
  ["stratum", ["bitcoin"], ["stratum protocol", "stratum"]],
  ["utreexo", ["bitcoin"], ["utreexo", "utreexo accumulator"]],
  ["assumeutxo", ["bitcoin"], ["assumeutxo", "assume utxo"]],
  ["pruning", ["bitcoin"], ["node pruning", "pruning"]],
  ["p2p", ["bitcoin"], ["peer to peer", "p2p"]],
  ["block-propagation", ["bitcoin"], ["block propagation", "block-propagation"]],
  ["signet", ["bitcoin"], ["signet", "bitcoin signet"]],
  ["testnet", ["bitcoin"], ["bitcoin testnet", "testnet"]],
  ["regtest", ["bitcoin"], ["regtest", "regression test"]],
  ["wallets", ["bitcoin"], ["bitcoin wallets", "wallets"]],
  ["hardware-wallet", ["bitcoin"], ["hardware wallet", "hardware-wallet"]],
  ["multisig", ["bitcoin", "cryptography"], ["multi signature", "multisig"]],
  ["descriptors", ["bitcoin"], ["output descriptors", "descriptors"]],
  ["psbt", ["bitcoin"], ["partially signed bitcoin", "psbt"]],
  ["miniscript", ["bitcoin", "cryptography"], ["miniscript", "mini script"]],
  ["lightning", ["lightning"], ["lightning network", "lightning"]],
  ["channels", ["lightning"], ["lightning channels", "channels"]],
  ["splicing", ["lightning"], ["channel splicing", "splicing"]],
  ["bolt12", ["lightning"], ["bolt 12", "bolt12"]],
  ["offers", ["lightning"], ["lightning offers", "offers"]],
  ["lnurl", ["lightning"], ["lnurl", "ln url"]],
  ["hold-invoices", ["lightning"], ["hold invoices", "hold-invoices"]],
  ["htlc", ["lightning"], ["hash time locked contract", "htlc"]],
  ["routing", ["lightning"], ["lightning routing", "routing"]],
  ["liquidity", ["lightning"], ["channel liquidity", "liquidity"]],
  ["watchtowers", ["lightning"], ["watchtowers", "watch towers"]],
  ["l402", ["lightning"], ["l402", "lightning 402"]],
  ["nostr", ["nostr"], ["nostr protocol", "nostr"]],
  ["nip", ["nostr"], ["nostr implementation possibilities", "nip"]],
  ["relay", ["nostr"], ["nostr relay", "relay"]],
  ["zaps", ["nostr"], ["nostr zaps", "zaps"]],
  ["bitcoin-core", ["bitcoin"], ["bitcoin core", "bitcoin-core"]],
  ["releases", ["bitcoin", "general-tech"], ["software releases", "releases"]],
  ["release-candidate", ["bitcoin", "general-tech"], ["release candidate", "release-candidate"]],
  ["testing-guide", ["bitcoin", "general-tech"], ["testing guide", "testing-guide"]],
  ["bips", ["bitcoin"], ["bitcoin improvement proposals", "bips"]],
  ["spec", ["bitcoin", "general-tech"], ["technical specification", "spec"]],
  ["security", ["bitcoin", "cryptography"], ["security research", "security"]],
  ["attacks", ["bitcoin", "security"], ["bitcoin attacks", "attacks"]],
  ["physical-attacks", ["bitcoin", "security"], ["physical attacks", "physical-attacks"]],
  ["custody", ["bitcoin"], ["bitcoin custody", "custody"]],
  ["self-custody", ["bitcoin"], ["self custody", "self-custody"]],
  ["kyc", ["bitcoin", "privacy"], ["know your customer", "kyc"]],
  ["tax", ["bitcoin"], ["bitcoin tax", "tax"]],
  ["accounting", ["bitcoin"], ["bitcoin accounting", "accounting"]],
  ["node", ["bitcoin"], ["bitcoin node", "node"]],
  ["node-software", ["bitcoin"], ["node software", "node-software"]],
  ["sdk", ["general-tech"], ["software development kit", "sdk"]],
  ["api", ["general-tech"], ["application programming interface", "api"]],
  ["rust", ["general-tech"], ["rust language", "rust"]],
  ["python", ["general-tech"], ["python language", "python"]],
  ["cli", ["general-tech"], ["command line interface", "cli"]],
  ["mobile", ["general-tech"], ["mobile application", "mobile"]],
  ["android", ["general-tech"], ["android app", "android"]],
  ["ios", ["general-tech"], ["ios app", "ios"]],
  ["mesh", ["general-tech"], ["mesh networking", "mesh"]],
  ["meshtastic", ["general-tech"], ["meshtastic network", "meshtastic"]],
  ["ai-agents", ["general-tech"], ["ai agents", "ai-agent"]],
  ["mcp", ["general-tech"], ["model context protocol", "mcp"]],
  ["reputation", ["general-tech"], ["reputation systems", "reputation"]],
  ["education", ["general-tech"], ["educational", "education"]],
  ["tutorial", ["general-tech"], ["how to guide", "tutorial"]],
  ["newsletter", ["general-tech"], ["newsletter", "news letter"]],
  ["research", ["general-tech"], ["research paper", "research"]],
  ["paper", ["general-tech"], ["academic paper", "paper"]],
  ["thesis", ["general-tech"], ["thesis", "doctoral thesis"]],
  ["quarterly-update", ["general-tech"], ["quarterly update", "quarterly-update"]],
  ["company", ["general-tech"], ["company", "corporation"]],
  ["funding", ["general-tech"], ["venture funding", "funding"]],
  ["merchant", ["bitcoin"], ["bitcoin merchant", "merchant"]],
  ["payments", ["bitcoin", "lightning"], ["bitcoin payments", "payments"]],
  ["point-of-sale", ["bitcoin"], ["point of sale", "point-of-sale"]],
  ["btcpay", ["bitcoin"], ["btcpay server", "btcpay"]],
  ["hardware", ["bitcoin"], ["bitcoin hardware", "hardware"]],
  ["blockstream-jade", ["bitcoin"], ["blockstream jade", "jade hardware"]],
  ["liquid", ["bitcoin"], ["liquid network", "liquid"]],
  ["sidechains", ["bitcoin"], ["side chain", "sidechains"]],
  ["federations", ["bitcoin"], ["federated sidechains", "federations"]],
  ["explorer", ["bitcoin"], ["block explorer", "explorer"]],
  ["statistics", ["bitcoin"], ["bitcoin statistics", "statistics"]],
  ["ordinals", ["bitcoin"], ["bitcoin ordinals", "ordinals"]],
  ["runes", ["bitcoin"], ["bitcoin runes", "runes"]],
  ["inscriptions", ["bitcoin"], ["bitcoin inscriptions", "inscriptions"]],
  ["tokens", ["bitcoin"], ["bitcoin tokens", "tokens"]],
  ["cryptography", ["bitcoin", "cryptography"], ["modern cryptography", "cryptography", "cryptographic"]],
  ["quantum", ["cryptography"], ["quantum computing", "quantum"]],
  ["key-exchange", ["cryptography"], ["key exchange", "key-exchange"]],
  ["public-key", ["cryptography"], ["public key", "public-key"]],
  ["hash-functions", ["cryptography"], ["hash functions", "hash-functions"]],
  ["zero-knowledge", ["cryptography"], ["zero knowledge", "zero-knowledge"]],
  ["encryption", ["cryptography"], ["encryption", "encrypted"]],
  ["authentication", ["cryptography"], ["authentication", "authenticating"]],
  ["web", ["general-tech"], ["web development", "web"]],
  ["javascript", ["general-tech"], ["javascript", "js language"]],
  ["open-source", ["general-tech"], ["open source", "open-source"]],
  ["documentation", ["general-tech"], ["technical documentation", "documentation"]],
  ["database", ["general-tech"], ["database", "databases"]],
  ["networking", ["general-tech"], ["computer networking", "networking"]],
  ["protocol", ["general-tech"], ["network protocol", "protocol"]],
  ["decentralization", ["bitcoin", "general-tech"], ["decentralized", "decentralization"]],
  ["open-web", ["general-tech"], ["open web", "open-web"]],
] as const;

export const RESOURCE_VOCABULARY: readonly ResourceSubject[] = ids.map(([id, domain, aliases]) => ({
  id,
  domain,
  aliases,
}));

export type SubjectMatch = { id: string; score: number; fields: readonly string[] };

const normalize = (value: string): string =>
  value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const occurrences = (text: string, alias: string): number => {
  const haystack = ` ${normalize(text)} `;
  const needle = normalize(alias);
  if (!needle) return 0;
  return Math.min(3, [...haystack.matchAll(new RegExp(`(?<![a-z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])`, "g"))].length);
};

export function matchSubjects(
  fields: { title?: string; description?: string; url?: string; site_name?: string },
  vocabulary: readonly ResourceSubject[] = RESOURCE_VOCABULARY,
  ruleDomains: readonly string[] = [],
): SubjectMatch[] {
  const values = [
    ["title", fields.title, 3],
    ["slug", fields.url ? new URL(fields.url).pathname : undefined, 2],
    ["description", fields.description, 1],
    ["site_name", fields.site_name, 1],
  ] as const;
  return vocabulary.flatMap((subject) => {
    let score = 0;
    const matchedFields: string[] = [];
    for (const [field, value, weight] of values) {
      if (!value) continue;
      const count = Math.max(...subject.aliases.map((alias) => occurrences(value, alias)));
      if (count > 0) {
        score += count * weight;
        matchedFields.push(field);
      }
    }
    if (!score) return [];
    const consistent = subject.domain.some((domain) => ruleDomains.includes(domain));
    return [{ id: subject.id, score: consistent ? score : score * 0.5, fields: matchedFields }];
  }).sort((a, b) => b.score - a.score);
}
