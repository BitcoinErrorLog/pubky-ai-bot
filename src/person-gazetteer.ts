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
 * `topicalTokens`: subject words the vocabulary and domain lists do not cover.
 * A capitalised phrase built from them (market-structure, analyst-reports) is
 * topic evidence, not a person.
 *
 * Bump the version whenever either list changes; it is recorded in every
 * manifest next to the drop reasons.
 */
export const PERSON_GAZETTEER_VERSION = "person-gazetteer-v2";

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
  "t-rowe-price",
  "charles-schwab",
  "franklin-templeton",
  "cantor-fitzgerald",
  "ark-invest",
]);

export const PERSON_GAZETTEER_TOPICAL_TOKENS: ReadonlySet<string> = new Set([
  // finance / markets
  "market", "markets", "structure", "reports", "report", "series", "round", "funding", "equities", "equity", "stocks",
  "stock", "bonds", "treasury", "treasuries", "etf", "etfs", "fund", "funds", "capital", "revenue", "earnings", "price",
  "prices", "inflation", "deflation", "rates", "yield", "credit", "debt", "deficit", "deficits", "budget", "wealth",
  "building", "money", "cash", "gold", "silver", "dollar", "euro", "yen", "reserve", "reserves", "liquidity",
  "liquidations", "leverage", "derivatives", "futures", "options", "perpetuals", "spot", "exchange", "exchanges",
  "trading", "traders", "investing", "investors", "investment", "portfolio", "hedge", "hedging", "custody", "insurance",
  // technology / crypto
  "crypto", "cryptocurrency", "cryptocurrencies", "token", "tokens", "tokenization", "tokenized", "stablecoin", "stablecoins",
  "blockchain", "chain", "chains", "layer", "layers", "protocol", "protocols", "network", "networks", "node", "nodes",
  "mining", "miners", "hashrate", "wallet", "wallets", "custodial", "hardware", "software", "data", "breach", "hack",
  "hacks", "exploit", "exploits", "security", "privacy", "encryption", "keys", "seed", "backup", "recovery", "ecosystem",
  "ecosystems", "projects", "project", "infrastructure", "developer", "developers", "release", "releases", "upgrade",
  "adoption", "payments", "payment", "remittances", "lightning", "bitcoin", "ethereum", "solana", "defi", "nft", "nfts",
  "ai", "agents", "digital", "assets", "asset", "onchain", "offchain", "world", "global", "super", "app", "apps",
  // policy / society
  "regulation", "regulations", "regulatory", "policy", "policymaking", "legislation", "bill", "bills", "vote", "votes",
  "election", "elections", "government", "federal", "state", "national", "tax", "taxes", "sanctions", "enforcement",
  "compliance", "legal", "lawsuit", "court", "justice", "crime", "fraud", "terrorism", "immigration", "war", "peace",
  "energy", "climate", "housing", "education", "health", "sports", "music", "photography", "gaming", "media", "video",
  "podcast", "newsletter", "conference", "survivor", "juice", "orange", "gen", "generation", "recap", "monthly", "weekly",
  "daily", "guide", "guides", "tools", "tips", "review", "analysis", "opinion", "interview", "discussion", "thread",
  // places
  "korea", "japan", "china", "india", "europe", "america", "africa", "asia", "germany", "france", "italy", "spain",
  "portugal", "brazil", "mexico", "argentina", "venezuela", "canada", "australia", "russia", "ukraine", "iran", "israel",
  "turkey", "nigeria", "kenya", "salvador", "switzerland", "singapore", "hong", "kong", "dubai", "london", "york",
  "texas", "florida", "california", "vegas", "washington", "south", "north", "east", "west", "united", "kingdom",
]);
