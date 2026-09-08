// Source: https://bitcoinops.org/en/topics/ (fetched 2026-09-08).
export const VOCABULARY_VERSION = "resource-subjects-v3";

export type SubjectDomain =
  | "dom:bitcoin"
  | "dom:lightning"
  | "dom:cryptography"
  | "dom:software"
  | "dom:nostr"
  | "dom:privacy"
  | "dom:security";
export type SubjectId = string & { readonly __subjectId: unique symbol };

export type ResourceSubject = {
  id: SubjectId;
  domain: readonly SubjectDomain[];
  aliases: readonly string[];
};

const ids = [
  ["consensus", ["dom:bitcoin"], ["consensus rules", "consensus"]],
  ["soft-fork", ["dom:bitcoin"], ["soft fork", "BIP8", "BIP9", "Soft fork activation"]],
  ["covenants", ["dom:bitcoin"], ["covenant", "covenants"]],
  ["ctv", ["dom:bitcoin"], ["check template verify", "ctv", "OP_CHECKTEMPLATEVERIFY"]],
  ["op-cat", ["dom:bitcoin"], ["op cat", "opcode cat"]],
  ["taproot", ["dom:bitcoin"], ["taproot", "tap root", "bip341", "bip 341"]],
  ["schnorr", ["dom:bitcoin", "dom:cryptography"], ["schnorr signature", "schnorr", "Schnorr signatures"]],
  ["musig", ["dom:bitcoin", "dom:cryptography"], ["mu sig", "musig"]],
  ["frost", ["dom:bitcoin", "dom:cryptography"], ["frost signature", "frost"]],
  ["signatures", ["dom:bitcoin", "dom:cryptography"], ["digital signatures", "signatures"]],
  ["hash-signatures", ["dom:cryptography"], ["hash based signatures", "slh dsa", "stateful hash", "hash signatures"]],
  ["post-quantum", ["dom:bitcoin", "dom:cryptography"], ["post quantum", "pqc", "quantum resistant", "quantum-safe", "quantum signatures", "Post-quantum cryptography", "Quantum resistance"]],
  ["privacy", ["dom:bitcoin", "dom:privacy"], ["bitcoin privacy", "privacy"]],
  ["payjoin", ["dom:bitcoin", "dom:privacy"], ["payjoin", "pay join", "BIP79", "Bustapay", "Pay-to-EndPoint"]],
  ["silent-payments", ["dom:bitcoin", "dom:privacy"], ["silent payments", "silent-payment", "bip352", "bip 352"]],
  ["coinjoin", ["dom:bitcoin", "dom:privacy"], ["coinjoin", "coin join"]],
  ["fingerprinting", ["dom:bitcoin", "dom:privacy"], ["wallet fingerprinting", "fingerprinting", "fingerprints"]],
  ["mempool", ["dom:bitcoin"], ["mempool", "memory pool"]],
  ["fees", ["dom:bitcoin"], ["transaction fees", "fees"]],
  ["rbf", ["dom:bitcoin"], ["replace by fee", "rbf", "BIP125", "Full-RBF", "Opt-in Replace-by-Fee", "Replace-by-fee (RBF)"]],
  ["cpfp", ["dom:bitcoin"], ["child pays for parent", "cpfp", "Ancestor feerate mining", "Child pays for parent (CPFP)"]],
  ["package-relay", ["dom:bitcoin"], ["package relay", "BIP331"]],
  ["mining", ["dom:bitcoin"], ["bitcoin mining", "mining"]],
  ["pooling", ["dom:bitcoin"], ["mining pool", "pooling", "Betterhash", "Braidpool", "Pooled mining", "Stratum v2"]],
  ["stratum", ["dom:bitcoin"], ["stratum protocol", "stratum"]],
  ["utreexo", ["dom:bitcoin"], ["utreexo", "utreexo accumulator"]],
  ["assumeutxo", ["dom:bitcoin"], ["assumeutxo", "assume utxo"]],
  ["pruning", ["dom:bitcoin"], ["node pruning", "pruning"]],
  ["p2p", ["dom:bitcoin"], ["peer to peer", "p2p"]],
  ["block-propagation", ["dom:bitcoin"], ["block propagation"]],
  ["signet", ["dom:bitcoin"], ["signet", "bitcoin signet"]],
  ["testnet", ["dom:bitcoin"], ["bitcoin testnet", "testnet", "Testnet3", "Testnet4"]],
  ["regtest", ["dom:bitcoin"], ["regtest", "regression test"]],
  ["wallets", ["dom:bitcoin"], ["bitcoin wallets", "wallets"]],
  ["hardware-wallet", ["dom:bitcoin"], ["hardware wallet"]],
  ["multisig", ["dom:bitcoin", "dom:cryptography"], ["multi signature", "multisig", "2pECDSA", "Scriptless multisignatures", "Two-Party ECDSA (2pECDSA)", "multisignature"]],
  ["descriptors", ["dom:bitcoin"], ["output descriptors", "descriptors", "Output script descriptors"]],
  ["psbt", ["dom:bitcoin"], ["partially signed bitcoin", "psbt", "BIP174", "Partially signed bitcoin transactions"]],
  ["miniscript", ["dom:bitcoin", "dom:cryptography"], ["miniscript", "mini script"]],
  ["lightning", ["dom:lightning"], ["lightning network", "lightning"]],
  ["channels", ["dom:lightning"], ["lightning channels", "channels"]],
  ["splicing", ["dom:lightning", "dom:bitcoin"], ["channel splicing", "splicing"]],
  ["bolt12", ["dom:lightning"], ["bolt 12", "bolt12"]],
  ["offers", ["dom:lightning", "dom:bitcoin"], ["lightning offers", "offers"]],
  ["lnurl", ["dom:lightning", "dom:bitcoin"], ["lnurl", "ln url", "Lightning Addresses"]],
  ["hold-invoices", ["dom:lightning", "dom:bitcoin"], ["hold invoices"]],
  ["htlc", ["dom:lightning", "dom:bitcoin"], ["hash time locked contract", "htlc", "Hash Time Locked Contract (HTLC)"]],
  ["routing", ["dom:lightning"], ["lightning routing", "routing"]],
  ["liquidity", ["dom:lightning"], ["channel liquidity", "liquidity"]],
  ["watchtowers", ["dom:lightning", "dom:bitcoin"], ["watchtowers", "watch towers"]],
  ["l402", ["dom:lightning"], ["l402", "lightning 402"]],
  ["nostr", ["dom:nostr"], ["nostr protocol", "nostr"]],
  ["nip", ["dom:nostr"], ["nostr implementation possibilities", "nip"]],
  ["relay", ["dom:nostr"], ["nostr relay", "relay"]],
  ["zaps", ["dom:nostr"], ["nostr zaps", "zaps"]],
  ["bitcoin-core", ["dom:bitcoin"], ["bitcoin core"]],
  ["releases", ["dom:bitcoin", "dom:software"], ["software releases", "releases"]],
  ["release-candidate", ["dom:bitcoin", "dom:software"], ["release candidate"]],
  ["testing-guide", ["dom:bitcoin", "dom:software"], ["testing guide"]],
  ["bips", ["dom:bitcoin"], ["bitcoin improvement proposals", "bips"]],
  ["spec", ["dom:bitcoin", "dom:software"], ["technical specification", "spec"]],
  ["security", ["dom:bitcoin", "dom:cryptography"], ["security research", "security"]],
  ["attacks", ["dom:bitcoin", "dom:security"], ["bitcoin attacks", "attacks"]],
  ["physical-attacks", ["dom:bitcoin", "dom:security"], ["physical attacks"]],
  ["custody", ["dom:bitcoin"], ["bitcoin custody", "custody"]],
  ["self-custody", ["dom:bitcoin"], ["self custody"]],
  ["kyc", ["dom:bitcoin", "dom:privacy"], ["know your customer", "kyc"]],
  ["tax", ["dom:bitcoin"], ["bitcoin tax", "tax"]],
  ["accounting", ["dom:bitcoin"], ["bitcoin accounting", "accounting"]],
  ["node", ["dom:bitcoin"], ["bitcoin node", "node"]],
  ["node-software", ["dom:bitcoin"], ["node software"]],
  ["sdk", ["dom:software"], ["software development kit", "sdk"]],
  ["api", ["dom:software"], ["application programming interface", "api"]],
  ["rust", ["dom:software"], ["rust language", "rust"]],
  ["python", ["dom:software"], ["python language", "python"]],
  ["cli", ["dom:software"], ["command line interface", "cli"]],
  ["mobile", ["dom:software"], ["mobile application", "mobile"]],
  ["android", ["dom:software"], ["android app", "android"]],
  ["ios", ["dom:software"], ["ios app", "ios"]],
  ["mesh", ["dom:software"], ["mesh networking", "mesh"]],
  ["meshtastic", ["dom:software"], ["meshtastic network", "meshtastic"]],
  ["ai-agents", ["dom:software"], ["ai agents", "ai-agent"]],
  ["mcp", ["dom:software"], ["model context protocol", "mcp"]],
  ["reputation", ["dom:software"], ["reputation systems", "reputation"]],
  ["education", ["dom:software"], ["educational", "education"]],
  ["tutorial", ["dom:software"], ["how to guide", "tutorial"]],
  ["newsletter", ["dom:software"], ["newsletter", "news letter"]],
  ["research", ["dom:software"], ["research paper", "research"]],
  ["paper", ["dom:software"], ["academic paper", "paper"]],
  ["thesis", ["dom:software"], ["thesis", "doctoral thesis"]],
  ["quarterly-update", ["dom:software"], ["quarterly update"]],
  ["funding", ["dom:software"], ["venture funding", "funding"]],
  ["merchant", ["dom:bitcoin"], ["bitcoin merchant", "merchant"]],
  ["payments", ["dom:bitcoin", "dom:lightning"], ["bitcoin payments", "payments"]],
  ["point-of-sale", ["dom:bitcoin"], ["point of sale"]],
  ["btcpay", ["dom:bitcoin"], ["btcpay server", "btcpay"]],
  ["hardware", ["dom:bitcoin"], ["bitcoin hardware", "hardware"]],
  ["blockstream-jade", ["dom:bitcoin"], ["blockstream jade", "jade hardware"]],
  ["liquid", ["dom:bitcoin"], ["liquid network", "liquid"]],
  ["sidechains", ["dom:bitcoin"], ["side chain", "sidechains"]],
  ["federations", ["dom:bitcoin"], ["federated sidechains", "federations"]],
  ["explorer", ["dom:bitcoin"], ["block explorer", "explorer"]],
  ["statistics", ["dom:bitcoin"], ["bitcoin statistics", "statistics"]],
  ["ordinals", ["dom:bitcoin"], ["bitcoin ordinals", "ordinals"]],
  ["runes", ["dom:bitcoin"], ["bitcoin runes", "runes"]],
  ["inscriptions", ["dom:bitcoin"], ["bitcoin inscriptions", "inscriptions"]],
  ["tokens", ["dom:bitcoin"], ["bitcoin tokens", "tokens"]],
  ["cryptography", ["dom:bitcoin", "dom:cryptography"], ["modern cryptography", "cryptography", "cryptographic"]],
  ["key-exchange", ["dom:cryptography"], ["key exchange"]],
  ["public-key", ["dom:cryptography"], ["public key"]],
  ["hash-functions", ["dom:cryptography"], ["hash functions"]],
  ["zero-knowledge", ["dom:cryptography"], ["zero knowledge"]],
  ["encryption", ["dom:cryptography"], ["encryption", "encrypted"]],
  ["authentication", ["dom:cryptography"], ["authentication", "authenticating"]],
  ["javascript", ["dom:software"], ["javascript", "js language"]],
  ["open-source", ["dom:software"], ["open source"]],
  ["database", ["dom:software"], ["database", "databases"]],
  ["networking", ["dom:software"], ["computer networking", "networking"]],
  ["decentralization", ["dom:bitcoin", "dom:software"], ["decentralized", "decentralization"]],
  ["open-web", ["dom:software"], ["open web"]],
  ["accidental-loss", ["dom:bitcoin"], ["Accidental confiscation", "accidental loss"]],
  ["acc", ["dom:bitcoin"], ["Accountable Computing Contracts", "BitVM", "Zero-Knowledge Contingent Payments (ZKCP)", "acc"]],
  ["adaptor-signatures", ["dom:bitcoin"], ["Adaptor signatures", "Scriptless scripts", "Signature adaptors"]],
  ["addr-v2", ["dom:bitcoin"], ["Addr v2"]],
  ["output-linking", ["dom:bitcoin"], ["Address reuse", "Dust attacks", "Output linking", "Reuse avoidance"]],
  ["amp", ["dom:bitcoin", "dom:lightning"], ["AMP", "Atomic multipath payments (AMPs)", "atomic-multipath"]],
  ["anchor-outputs", ["dom:bitcoin", "dom:lightning"], ["Anchor outputs", "Simplified commitments"]],
  ["annex", ["dom:bitcoin"], ["Annex"]],
  ["anonymity-networks", ["dom:bitcoin"], ["Anonymity networks", "I2P", "Tor"]],
  ["fee-sniping", ["dom:bitcoin"], ["Anti fee sniping", "Fee sniping"]],
  ["ark", ["dom:bitcoin"], ["Ark protocol", "ark"]],
  ["asicboost", ["dom:bitcoin"], ["ASICBoost", "Covert ASICBoost", "Overt ASICBoost"]],
  ["async-payments", ["dom:bitcoin"], ["Async payments"]],
  ["attributable-fail", ["dom:bitcoin"], ["Attributable failures", "attributable fail"]],
  ["multipath-payments", ["dom:bitcoin", "dom:lightning"], ["Base AMP", "Multipart payments", "Multipath payments", "Simplified multipath payments"]],
  ["bitcoin-lisp", ["dom:bitcoin"], ["Basic Bitcoin Lisp Language (bll)", "bllsh", "BTC Lisp", "symbll", "basic-bitcoin-lisp-language", "bitcoin lisp"]],
  ["payment-batching", ["dom:bitcoin"], ["Batching", "Payment batching"]],
  ["bech32", ["dom:bitcoin"], ["Bech32", "Bech32(m)", "Bech32m", "BIP173", "Native segwit address"]],
  ["hd-key-generation", ["dom:bitcoin"], ["BIP32", "HD key generation", "HD wallets"]],
  ["bloom-filters", ["dom:bitcoin"], ["BIP37", "Bloom filters", "Transaction bloom filtering"]],
  ["consensus-cleanup", ["dom:bitcoin"], ["BIP54", "Consensus cleanup soft fork", "consensus cleanup"]],
  ["bip70", ["dom:bitcoin"], ["BIP70 payment protocol", "bip70"]],
  ["codex32", ["dom:bitcoin"], ["BIP93", "Codex32"]],
  ["v2-transport", ["dom:bitcoin"], ["BIP151", "BIP324", "Version 2 P2P transport", "v2-p2p-transport", "bip 324", "v2 transport"]],
  ["compact-block-relay", ["dom:bitcoin"], ["BIP152", "Compact block relay"]],
  ["dandelion", ["dom:bitcoin"], ["BIP156", "Dandelion"]],
  ["block-filters", ["dom:bitcoin"], ["BIP157", "BIP158", "Compact block filters", "Neutrino protocol", "block filters"]],
  ["generic-signmessage", ["dom:bitcoin"], ["BIP322", "Generic signmessage", "Signmessage"]],
  ["rendez-vous-routing", ["dom:bitcoin", "dom:lightning"], ["Blinded paths", "Hidden destinations", "Rendez-vous routing", "Route blinding"]],
  ["duplicate-tx", ["dom:bitcoin"], ["Block 1,983,702 problem", "Duplicate transactions", "duplicate tx"]],
  ["block-explorers", ["dom:bitcoin"], ["Block explorers"]],
  ["block-withholding", ["dom:bitcoin"], ["Block withholding", "Oblivious shares"]],
  ["bls-signatures", ["dom:bitcoin"], ["BLS signatures"]],
  ["redundant-payments", ["dom:bitcoin"], ["Boomerang payments", "Redundant overpayments", "Stuckless payments", "redundant payments"]],
  ["channel-gossip", ["dom:bitcoin", "dom:lightning"], ["Channel announcements", "Gossip (LN)", "channel gossip"]],
  ["commitment-upgrades", ["dom:bitcoin", "dom:lightning"], ["Channel commitment upgrades", "commitment upgrades"]],
  ["channel-factories", ["dom:bitcoin", "dom:lightning"], ["Channel factories"]],
  ["channel-jamming", ["dom:bitcoin", "dom:lightning"], ["Channel jamming attacks", "channel jamming"]],
  ["client-validation", ["dom:bitcoin"], ["Client-side validation", "RGB", "Shielded CSV", "Taproot Assets", "Taro", "client validation"]],
  ["cltv-expiry-delta", ["dom:bitcoin"], ["CLTV expiry delta"]],
  ["cluster-mempool", ["dom:bitcoin"], ["Cluster mempool"]],
  ["coin-selection", ["dom:bitcoin"], ["Coin selection"]],
  ["joinpools", ["dom:bitcoin"], ["Coinpools", "Joinpools", "Payment pools"]],
  ["coinswap", ["dom:bitcoin"], ["Coinswap"]],
  ["countersign", ["dom:bitcoin"], ["Countersign"]],
  ["cpfp-carve-out", ["dom:bitcoin"], ["CPFP carve out"]],
  ["cisa", ["dom:bitcoin"], ["Cross-input signature aggregation (CISA)", "Half aggregation", "cross-input-signature-aggregation", "cisa"]],
  ["cve", ["dom:bitcoin"], ["CVE-2012-2459", "CVE-2013-2292", "CVE-2015-3641", "CVE-2015-6031", "CVE-2017-12842", "CVE-2017-18350", "CVE-2018-17145", "CVE-2020-14198", "CVE-2020-26895", "CVE-2020-26896", "CVE-2021-31876", "CVE-2023-39910", "CVE-2024-52911", "CVEs (various)", "cve"]],
  ["cve-2018-17144", ["dom:bitcoin"], ["CVE-2018-17144", "Duplicate inputs vulnerability"]],
  ["min-relay-fees", ["dom:bitcoin"], ["Default minimum transaction relay feerates", "min relay fees"]],
  ["signer-delegation", ["dom:bitcoin"], ["Delegation", "Signer delegation"]],
  ["difficulty-adjust", ["dom:bitcoin"], ["Difficulty adjustment algorithms", "difficulty adjust"]],
  ["dlc", ["dom:bitcoin"], ["Discreet Log Contracts (DLCs)", "discreet-log-contracts", "dlc"]],
  ["dleq", ["dom:bitcoin"], ["Discrete log equivalency (DLEQ)", "Proofs of discrete log equivalency (PODLE)", "discrete-log-equivalency", "dleq"]],
  ["dual-funding", ["dom:bitcoin"], ["Dual funding", "Interactive funding protocol"]],
  ["duplex-channels", ["dom:bitcoin", "dom:lightning"], ["Duplex micropayment channels", "duplex channels"]],
  ["uneconomical-outputs", ["dom:bitcoin"], ["Dust", "Uneconomical outputs"]],
  ["ecash", ["dom:bitcoin"], ["Ecash"]],
  ["eclipse-attacks", ["dom:bitcoin"], ["Eclipse attacks"]],
  ["eltoo", ["dom:bitcoin", "dom:lightning"], ["Eltoo", "LN-Symmetry"]],
  ["fee-sourcing", ["dom:bitcoin"], ["Endogenous fees", "Exogenous fees", "Fee sourcing"]],
  ["ephemeral-anchors", ["dom:bitcoin"], ["Ephemeral anchors", "Ephemeral dust", "Pay-to-Anchor (P2A)"]],
  ["erlay", ["dom:bitcoin"], ["Erlay"]],
  ["anti-exfil-signing", ["dom:bitcoin"], ["Exfiltration-resistant signing", "anti exfil signing"]],
  ["expiration-floods", ["dom:bitcoin"], ["Expiration floods", "Flood and loot", "Forced expiration spam"]],
  ["fee-estimation", ["dom:bitcoin"], ["Fee estimation"]],
  ["fee-sponsorship", ["dom:bitcoin"], ["Fee sponsorship"]],
  ["free-relay", ["dom:bitcoin"], ["Free relay"]],
  ["gap-limits", ["dom:bitcoin"], ["Gap limits"]],
  ["reproducible-builds", ["dom:bitcoin"], ["Gitian", "Guix", "Reproducible builds"]],
  ["hwi", ["dom:bitcoin"], ["Hardware wallet interface (HWI)", "hwi"]],
  ["htlc-endorsement", ["dom:bitcoin", "dom:lightning"], ["HTLC endorsement"]],
  ["inbound-fees", ["dom:bitcoin"], ["Inbound forwarding fees", "inbound fees"]],
  ["jit-channels", ["dom:bitcoin", "dom:lightning"], ["Just-In-Time (JIT) channels", "jit-channels"]],
  ["jit-routing", ["dom:bitcoin", "dom:lightning"], ["Just-in-time (JIT) routing", "jit-routing"]],
  ["spontaneous-payments", ["dom:bitcoin", "dom:lightning"], ["Keysend", "Spontaneous payments"]],
  ["kindred-rbf", ["dom:bitcoin"], ["Kindred replace by fee", "Sibling eviction", "kindred rbf"]],
  ["large-channels", ["dom:bitcoin", "dom:lightning"], ["Large channels", "Wumbo"]],
  ["minisketch", ["dom:bitcoin"], ["Libminisketch", "Minisketch"]],
  ["liquidity-ads", ["dom:bitcoin", "dom:lightning"], ["Liquidity advertisements", "liquidity ads"]],
  ["ln-penalty", ["dom:bitcoin", "dom:lightning"], ["LN-Penalty"]],
  ["low-r-grinding", ["dom:bitcoin"], ["Low-r grinding", "Signature grinding"]],
  ["mast", ["dom:bitcoin"], ["MAST"]],
  ["matt-contracts", ["dom:bitcoin"], ["Merkleize All The Things", "OP_CHECKCONTRACTVERIFY"]],
  ["merkle-vulns", ["dom:bitcoin"], ["Merkle tree vulnerabilities", "merkle vulns"]],
  ["onion-messages", ["dom:bitcoin"], ["Onion messages"]],
  ["op-checksigfromstack", ["dom:bitcoin"], ["OP_CHECKSIGFROMSTACK"]],
  ["op-codeseparator", ["dom:bitcoin"], ["OP_CODESEPARATOR"]],
  ["oob-fees", ["dom:bitcoin"], ["Out-of-band fees", "oob fees"]],
  ["p2c", ["dom:bitcoin"], ["Pay-to-Contract (P2C) protocols", "pay-to-contract-outputs", "p2c"]],
  ["payment-probes", ["dom:bitcoin"], ["Payment probes", "Probing"]],
  ["payment-secrets", ["dom:bitcoin"], ["Payment secrets"]],
  ["peer-storage", ["dom:bitcoin"], ["Peer storage"]],
  ["ptlc", ["dom:bitcoin"], ["Point Time Locked Contracts (PTLCs)", "ptlc"]],
  ["unannounced-channels", ["dom:bitcoin", "dom:lightning"], ["Private channels", "Unannounced channels"]],
  ["probabilistic-pay", ["dom:bitcoin"], ["Probabilistic payments", "probabilistic pay"]],
  ["proof-of-payment", ["dom:bitcoin"], ["Proof of payment"]],
  ["proof-of-reserves", ["dom:bitcoin"], ["Proof of reserves"]],
  ["replacement-cycling", ["dom:bitcoin"], ["Replacement cycling"]],
  ["disclosures", ["dom:bitcoin"], ["Responsible disclosures", "disclosures"]],
  ["segregated-witness", ["dom:bitcoin"], ["Segregated witness"]],
  ["selfish-mining", ["dom:bitcoin"], ["Selfish mining"]],
  ["side-channels", ["dom:bitcoin", "dom:lightning"], ["Side channels"]],
  ["sighash-anyprevout", ["dom:bitcoin"], ["SIGHASH_ANYPREVOUT", "SIGHASH_NOINPUT"]],
  ["taproot-channels", ["dom:bitcoin", "dom:lightning"], ["Simple taproot channels", "taproot channels"]],
  ["simplicity", ["dom:bitcoin"], ["Simplicity"]],
  ["statechains", ["dom:bitcoin"], ["Statechains"]],
  ["stateless-invoices", ["dom:bitcoin", "dom:lightning"], ["Stateless invoices"]],
  ["channel-backups", ["dom:bitcoin", "dom:lightning"], ["Static channel backups", "channel backups"]],
  ["submarine-swaps", ["dom:bitcoin"], ["Submarine swaps"]],
  ["swap-in-potentiam", ["dom:bitcoin"], ["Swap-in Potentiam (SIP)", "swap-in-potentiam"]],
  ["tapscript", ["dom:bitcoin"], ["Tapscript"]],
  ["threshold-signature", ["dom:bitcoin"], ["Threshold signature"]],
  ["time-warp", ["dom:bitcoin"], ["Time warp"]],
  ["timelocks", ["dom:bitcoin"], ["Timelocks"]],
  ["timeout-trees", ["dom:bitcoin"], ["Timeout trees"]],
  ["v3-relay", ["dom:bitcoin"], ["Topologically Restricted Until Confirmation (TRUC)", "Version 3 transaction relay", "v3 relay"]],
  ["trampoline-payments", ["dom:bitcoin", "dom:lightning"], ["Trampoline payments"]],
  ["tx-origin-privacy", ["dom:bitcoin"], ["Transaction origin privacy", "tx origin privacy"]],
  ["transaction-pinning", ["dom:bitcoin"], ["Transaction pinning"]],
  ["transitory-forks", ["dom:bitcoin"], ["Transitory soft forks", "transitory forks"]],
  ["trimmed-htlc", ["dom:bitcoin", "dom:lightning"], ["Trimmed HTLC"]],
  ["v3-commitments", ["dom:bitcoin", "dom:lightning"], ["V3 commitments", "Zero-fee commitments"]],
  ["vaults", ["dom:bitcoin"], ["Vaults"]],
  ["wallet-labels", ["dom:bitcoin"], ["Wallet labels"]],
  ["x-only-keys", ["dom:bitcoin"], ["X-only public keys", "x only keys"]],
  ["zero-conf-channels", ["dom:bitcoin", "dom:lightning"], ["Zero-conf channels"]],
] as const;

export const RESOURCE_VOCABULARY: readonly ResourceSubject[] = ids.map(([id, domain, aliases]) => ({
  id: id as SubjectId,
  domain,
  aliases,
}));

export type SubjectMatch = { id: SubjectId; score: number; fields: readonly string[] };

export const SUBJECT_DOMAIN_NAMES: readonly SubjectDomain[] = [
  "dom:bitcoin",
  "dom:lightning",
  "dom:cryptography",
  "dom:software",
  "dom:nostr",
  "dom:privacy",
  "dom:security",
];

export const SUBJECT_DOMAIN_LABELS: Readonly<Partial<Record<SubjectDomain, SubjectId>>> = {
  "dom:bitcoin": "bitcoin" as SubjectId,
  "dom:lightning": "lightning" as SubjectId,
  "dom:cryptography": "cryptography" as SubjectId,
  "dom:nostr": "nostr" as SubjectId,
  "dom:privacy": "privacy" as SubjectId,
  "dom:security": "security" as SubjectId,
};

const RULE_LABEL_DOMAINS: Readonly<Partial<Record<string, SubjectDomain>>> = {
  bitcoin: "dom:bitcoin",
  lightning: "dom:lightning",
  cryptography: "dom:cryptography",
  software: "dom:software",
  programming: "dom:software",
  nostr: "dom:nostr",
  privacy: "dom:privacy",
  security: "dom:security",
};

const SUBJECT_SUPERSEDES: Readonly<Record<string, readonly string[]>> = {
  "self-custody": ["custody"],
};

export const normalize = (value: string): string =>
  value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export const occurrences = (haystack: string, alias: string): number => {
  const needle = normalize(alias);
  if (!needle) return 0;
  const pattern = new RegExp(
    `(?<![a-z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])`,
    "g",
  );
  let count = 0;
  while (pattern.exec(` ${haystack} `) !== null && ++count < 3) {}
  return count;
};

export function matchSubjects(
  fields: { title?: string; description?: string; url?: string; site_name?: string },
  vocabulary: readonly ResourceSubject[] = RESOURCE_VOCABULARY,
  ruleDomains: readonly string[] = [],
): SubjectMatch[] {
  const activeDomains = new Set(ruleDomains.flatMap((label) => {
    const domain = RULE_LABEL_DOMAINS[label];
    return domain ? [domain] : [];
  }));
  const rawValues: readonly (readonly [string, string | undefined, number])[] = [
    ["title", fields.title?.slice(0, 512), 3],
    ["slug", fields.url ? new URL(fields.url).pathname.slice(0, 512) : undefined, 2],
    ["description", fields.description?.slice(0, 4096), 1],
    ["site_name", fields.site_name?.slice(0, 256), 1],
  ];
  const values = rawValues.map(([field, value, weight]) => [field, value ? normalize(value) : undefined, weight] as const);
  const matches = vocabulary.flatMap((subject) => {
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
    const consistent = subject.domain.some((domain) => activeDomains.has(domain));
    return [{ id: subject.id, score: consistent ? score : score * 0.5, fields: matchedFields }];
  }).sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));
  const superseded = new Set(matches.flatMap((match) => SUBJECT_SUPERSEDES[match.id] ?? []));
  return matches.filter((match) => !superseded.has(match.id));
}
