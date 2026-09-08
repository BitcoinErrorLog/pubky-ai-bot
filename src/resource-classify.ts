import { isValidOpenTagLabel } from "./bot-kit/tags/policy.js";
import type { Taxonomy } from "./resource-taxonomy.js";

export type ResourceRuleMatch = {
  host?: string;
  hostSuffix?: string;
  hostRegex?: RegExp;
  pathPrefix?: string;
  pathRegex?: RegExp;
  titleRegex?: RegExp;
  source?: string;
};

export type ResourceRuleEmit = Pick<Taxonomy, "domain" | "type" | "subject" | "geography">;

export type ResourceRule = {
  id: string;
  match: ResourceRuleMatch;
  emit: ResourceRuleEmit;
  weight: number;
  stopOnMatch?: boolean;
  reject?: boolean;
};

export type ResourceClassificationInput = {
  value: string;
  title?: string;
  source: string;
  labels?: readonly string[];
};

export type ResourceClassification = {
  taxonomy: ResourceRuleEmit;
  rules: string[];
  score: number;
  category?: string;
  matched: boolean;
  rejectionReason?: string;
};

export const RESOURCE_LABEL_CAP = 5;

const emptyTaxonomy = (): ResourceRuleEmit => ({ domain: [], type: [], subject: [], geography: [] });
const rule = (
  id: string,
  match: ResourceRuleMatch,
  emit: Partial<ResourceRuleEmit>,
  weight: number,
  stopOnMatch = false,
  reject = false,
): ResourceRule => ({ id, match, emit: { ...emptyTaxonomy(), ...emit }, weight, stopOnMatch, reject });

const PROJECT_HOSTS = [
  "github.com/bitcoin/bitcoin",
  "github.com/lightningnetwork/lnd",
  "github.com/ElementsProject/lightning",
  "github.com/ACINQ/eclair",
];

export const RESOURCE_RULES: readonly ResourceRule[] = [
  rule("bitcoin.org", { host: "bitcoin.org" }, { domain: ["bitcoin"], type: ["documentation"] }, 30),
  rule("bitcoin.org.developer", { host: "bitcoin.org", pathPrefix: "/en/developer-" }, { type: ["developer"] }, 35),
  rule("bitcoin.org.guide", { host: "bitcoin.org", pathRegex: /\/en\/[^/]*guide/i }, { type: ["developer"] }, 35),
  rule("bitcoin.it", { host: "en.bitcoin.it" }, { domain: ["bitcoin"], type: ["wiki"] }, 32),
  rule("bitcoin.it.root", { host: "bitcoin.it" }, { domain: ["bitcoin"], type: ["wiki"] }, 32),
  rule("bitcoin.bips", { host: "github.com", pathPrefix: "/bitcoin/bips" }, { domain: ["bitcoin"], type: ["bip", "spec"] }, 60, true),
  rule("bitcoin.core", { host: "github.com", pathPrefix: "/bitcoin/bitcoin" }, { domain: ["bitcoin"], subject: ["bitcoin-core"], type: ["software"] }, 58),
  rule("bitcoin.core.homepage", { host: "github.com", pathPrefix: "/bitcoin/bitcoin", pathRegex: /\/bitcoin\/bitcoin\/?$/ }, { type: ["homepage"] }, 12),
  rule("lightning.bolts", { host: "github.com", pathPrefix: "/lightning/bolts" }, { domain: ["lightning"], type: ["bolt", "spec"] }, 60),
  ...PROJECT_HOSTS.slice(1).map((path) =>
    rule(`project.${path.slice("github.com/".length)}`, { host: "github.com", pathPrefix: `/${path.slice("github.com/".length)}` }, { domain: ["lightning"], type: ["software"] }, 48),
  ),
  rule("lightning.lightningdevkit", { host: "github.com", pathRegex: /^\/lightningdevkit\// }, { domain: ["lightning"], type: ["software"] }, 48, true),
  rule("github.pull-request", { host: "github.com", pathRegex: /\/pull\// }, { type: ["pull-request"] }, 20),
  rule("github.issue", { host: "github.com", pathRegex: /\/issues\// }, { type: ["issue"] }, 20),
  rule("github.release", { host: "github.com", pathRegex: /\/releases(?:\/|$)/ }, { type: ["release"] }, 20),
  rule("bitcoinops", { host: "bitcoinops.org" }, { domain: ["bitcoin"] }, 35),
  rule("bitcoinops.newsletter", { host: "bitcoinops.org", pathPrefix: "/en/newsletters/" }, { type: ["newsletter"] }, 40),
  rule("bitcoinops.topic", { host: "bitcoinops.org", pathPrefix: "/en/topics/" }, { type: ["topic"] }, 35),
  rule("mempool", { host: "mempool.space" }, { domain: ["bitcoin"], type: ["explorer", "tool"] }, 45),
  rule("blockstream", { host: "blockstream.info" }, { domain: ["bitcoin"], type: ["explorer"] }, 40),
  rule("blockstream.rewards-excluded", { hostRegex: /^rewards\.blockstream\.com$/ }, {}, 0, true, true),
  rule("blockstream.store", { host: "store.blockstream.com" }, { domain: ["bitcoin"], type: ["merchant", "hardware"] }, 55, true),
  rule("blockstream.company", { hostSuffix: "blockstream.com" }, { domain: ["bitcoin"], subject: ["company"] }, 35),
  rule("blockstream.homepage", { host: "blockstream.com", pathRegex: /^\/$/ }, { type: ["homepage"] }, 12),
  rule("blockstream.blog", { host: "blog.blockstream.com" }, { type: ["article"] }, 15),
  rule("blog.host", { hostRegex: /^blog\./ }, { type: ["article"] }, 15),
  rule("blog.path", { pathPrefix: "/blog/" }, { type: ["article"] }, 15),
  rule("docs.host", { hostRegex: /^docs\./ }, { type: ["documentation"] }, 15),
  rule("docs.path", { pathPrefix: "/docs/" }, { type: ["documentation"] }, 15),
  rule("delvingbitcoin", { host: "delvingbitcoin.org" }, { domain: ["bitcoin"], subject: ["research"] }, 40),
  rule("delvingbitcoin.discussion", { host: "delvingbitcoin.org", pathPrefix: "/t/" }, { type: ["discussion"] }, 20),
  rule("bitcoincore.bin-excluded", { host: "bitcoincore.org", pathPrefix: "/bin/" }, {}, 0, true, true),
  rule("bitcoincore", { host: "bitcoincore.org" }, { domain: ["bitcoin"], subject: ["bitcoin-core"] }, 40),
  rule("bitcoincore.release", { host: "bitcoincore.org", pathPrefix: "/en/releases/" }, { type: ["release", "documentation"] }, 25),
  rule("bitcoincore.documentation", { host: "bitcoincore.org", pathPrefix: "/en/" }, { type: ["documentation"] }, 20),
  rule("github.bitcoin-core", { host: "github.com", pathPrefix: "/bitcoin-core/" }, { domain: ["bitcoin"], subject: ["bitcoin-core"], type: ["software"] }, 52),
  rule("github.bitcoin-core.wiki", { host: "github.com", pathRegex: /^\/bitcoin-core\/[^/]+\/wiki\// }, { type: ["wiki"] }, 18),
  rule("btcpayserver", { hostSuffix: "btcpayserver.org" }, { domain: ["bitcoin"], subject: ["software", "payments"] }, 42),
  rule("github.btcpayserver", { host: "github.com", pathPrefix: "/btcpayserver/" }, { domain: ["bitcoin"], subject: ["software", "payments"] }, 42),
  rule("github.utreexo", { host: "github.com", pathPrefix: "/utreexo/" }, { domain: ["bitcoin"], subject: ["software", "research"] }, 42),
  rule("github.jlopp", { host: "github.com", pathPrefix: "/jlopp/" }, { domain: ["bitcoin"], subject: ["security", "research"] }, 42),
  rule("music.spotify", { host: "open.spotify.com" }, { domain: ["music"] }, 25),
  rule("music.spotify.track", { host: "open.spotify.com", pathPrefix: "/track/" }, { type: ["music-track"] }, 45),
  rule("music.spotify.album", { host: "open.spotify.com", pathPrefix: "/album/" }, { type: ["music-album"] }, 45),
  rule("music.spotify.artist", { host: "open.spotify.com", pathPrefix: "/artist/" }, { type: ["music-artist"] }, 45),
  rule("music.spotify.playlist", { host: "open.spotify.com", pathPrefix: "/playlist/" }, { type: ["music-playlist"] }, 45),
  rule("music.apple", { host: "music.apple.com" }, { domain: ["music"] }, 25),
  rule("music.apple.track", { host: "music.apple.com", pathRegex: /\/(song|track)\// }, { type: ["music-track"] }, 35),
  rule("music.apple.album", { host: "music.apple.com", pathRegex: /\/album\// }, { type: ["music-album"] }, 35),
  rule("music.apple.artist", { host: "music.apple.com", pathRegex: /\/artist\// }, { type: ["music-artist"] }, 35),
  rule("music.apple.playlist", { host: "music.apple.com", pathRegex: /\/playlist\// }, { type: ["music-playlist"] }, 35),
  rule("music.bandcamp", { hostSuffix: "bandcamp.com" }, { domain: ["music"] }, 25),
  rule("music.bandcamp.artist-root", { hostRegex: /.+\.bandcamp\.com$/, pathRegex: /^\/$/ }, { type: ["music-artist"] }, 45),
  rule("music.bandcamp.track", { hostSuffix: "bandcamp.com", pathPrefix: "/track/" }, { type: ["music-track"] }, 45),
  rule("music.bandcamp.album", { hostSuffix: "bandcamp.com", pathPrefix: "/album/" }, { type: ["music-album"] }, 45),
  rule("music.bandcamp.artist", { hostSuffix: "bandcamp.com", pathRegex: /^\/[^/]+\/?$/ }, { type: ["music-artist"] }, 45),
  rule("music.soundcloud", { host: "soundcloud.com" }, { domain: ["music"] }, 25),
  rule("music.soundcloud.playlist", { host: "soundcloud.com", pathPrefix: "/sets/" }, { type: ["music-playlist"] }, 45),
  rule("music.soundcloud.track", { host: "soundcloud.com", pathRegex: /^\/[^/]+\/(?!sets\/)[^/]+/ }, { type: ["music-track"] }, 40),
  rule("music.discogs", { host: "discogs.com" }, { domain: ["music"] }, 25),
  rule("music.discogs.album", { host: "discogs.com", pathRegex: /^\/(release|master)\// }, { type: ["music-album"] }, 45),
  rule("music.discogs.artist", { host: "discogs.com", pathPrefix: "/artist/" }, { type: ["music-artist"] }, 45),
  rule("music.discogs.label", { host: "discogs.com", pathPrefix: "/label/" }, { type: ["music-label"] }, 45),
  rule("music.musicbrainz", { host: "musicbrainz.org" }, { domain: ["music"] }, 25),
  rule("music.musicbrainz.recording", { host: "musicbrainz.org", pathPrefix: "/recording/" }, { type: ["music-track"] }, 42),
  rule("music.musicbrainz.release", { host: "musicbrainz.org", pathPrefix: "/release/" }, { type: ["music-album"] }, 42),
  rule("music.musicbrainz.artist", { host: "musicbrainz.org", pathPrefix: "/artist/" }, { type: ["music-artist"] }, 42),
  rule("music.musicbrainz.label", { host: "musicbrainz.org", pathPrefix: "/label/" }, { type: ["music-label"] }, 42),
  rule("music.musicbrainz.work", { host: "musicbrainz.org", pathPrefix: "/work/" }, { type: ["music-recording"] }, 42),
  ...["bbc.com", "cointelegraph.com", "news.ycombinator.com", "techcrunch.com", "theverge.com", "wired.com", "arstechnica.com", "coindesk.com"].map((host) =>
    rule(`news.${host}`, { host }, { domain: ["news"], type: ["homepage"] }, 25),
  ),
  rule("python", { host: "python.org" }, { domain: ["software"], type: ["programming", "homepage"] }, 30),
  rule("rust", { host: "rust-lang.org" }, { domain: ["software"], type: ["programming", "homepage"] }, 30),
  rule("nostr", { host: "nostr.com" }, { domain: ["nostr"], type: ["homepage"] }, 30),
  rule("wikipedia", { host: "en.wikipedia.org", pathPrefix: "/wiki/" }, { domain: ["reference"], subject: ["wikipedia"] }, 30),
  rule("wikipedia.bitcoin.path", { host: "en.wikipedia.org", pathRegex: /^\/wiki\/.*bitcoin/i }, { domain: ["bitcoin"] }, 18),
  rule("wikipedia.bitcoin.title", { host: "en.wikipedia.org", titleRegex: /bitcoin/i }, { domain: ["bitcoin"] }, 18),
  rule("wikipedia.cryptography.path", { host: "en.wikipedia.org", pathRegex: /^\/wiki\/.*cryptography/i }, { subject: ["cryptography"] }, 18),
  rule("wikipedia.cryptography.title", { host: "en.wikipedia.org", titleRegex: /cryptography/i }, { subject: ["cryptography"] }, 18),
  rule("developer.mozilla", { host: "developer.mozilla.org" }, { type: ["documentation"], subject: ["web"] }, 30),
  rule("stackoverflow", { host: "stackoverflow.com" }, { domain: ["programming"], type: ["qa"] }, 30),
  rule("github.homepage", { host: "github.com", pathRegex: /^\/$/ }, { domain: ["software"], type: ["homepage"] }, 30),
  rule("homepage.project", { pathRegex: /^\/$/, titleRegex: /project|open source|software/i }, { type: ["homepage"] }, 8),
];

const hostMatches = (host: string, ruleMatch: ResourceRuleMatch): boolean => {
  if (ruleMatch.host && host !== ruleMatch.host) return false;
  if (ruleMatch.hostSuffix && host !== ruleMatch.hostSuffix && !host.endsWith(`.${ruleMatch.hostSuffix}`)) return false;
  if (ruleMatch.hostRegex && !ruleMatch.hostRegex.test(host)) return false;
  return true;
};

function validTags(tags: readonly string[]): string[] {
  return tags.filter((tag) => isValidOpenTagLabel(tag));
}

export function classifyResource(input: ResourceClassificationInput, sourceDefault?: { unmatched: "reject" | "source-default"; allowOperatorLabels?: boolean }): ResourceClassification {
  const url = new URL(input.value);
  const host = url.hostname.toLowerCase().replace(/\.+$/, "").replace(/^www\./, "");
  const path = url.pathname || "/";
  const taxonomy = emptyTaxonomy();
  const matched: ResourceRule[] = [];
  for (const candidate of RESOURCE_RULES) {
    const m = candidate.match;
    if (!hostMatches(host, m) || (m.pathPrefix && !path.startsWith(m.pathPrefix)) || (m.pathRegex && !m.pathRegex.test(path)) || (m.titleRegex && !m.titleRegex.test(input.title ?? "")) || (m.source && m.source !== input.source)) continue;
    matched.push(candidate);
    for (const key of ["domain", "type", "subject", "geography"] as const) taxonomy[key].push(...candidate.emit[key]);
    if (candidate.stopOnMatch) break;
  }
  if (matched.length === 0 && sourceDefault?.unmatched === "source-default" && sourceDefault.allowOperatorLabels) taxonomy.subject.push(...(input.labels ?? []));
  for (const key of ["domain", "type", "subject", "geography"] as const) taxonomy[key] = [...new Set(validTags(taxonomy[key]))];
  const music = taxonomy.domain.includes("music");
  const hasMusicType = taxonomy.type.some((tag) => tag.startsWith("music-"));
  const rejectedRule = matched.find((item) => item.reject);
  const matchedValid = !rejectedRule && matched.length > 0 && (!music || hasMusicType);
  const ordered = ["domain", "type", "subject", "geography"] as const;
  const labels = ordered.flatMap((key) => taxonomy[key]);
  const capped = new Set(labels.slice(0, RESOURCE_LABEL_CAP));
  const score = matched.reduce((sum, item) => sum + item.weight, 0) + (path !== "/" && hasMusicType ? 12 : path !== "/" ? 5 : 0);
  return {
    taxonomy: {
      domain: taxonomy.domain.filter((tag) => capped.has(tag)),
      type: taxonomy.type.filter((tag) => capped.has(tag)),
      subject: taxonomy.subject.filter((tag) => capped.has(tag)),
      geography: taxonomy.geography.filter((tag) => capped.has(tag)),
    },
    rules: matched.map((item) => item.id),
    score,
    category: taxonomy.domain[0],
    matched: matchedValid || (matched.length === 0 && sourceDefault?.unmatched === "source-default"),
    rejectionReason: rejectedRule ? "excluded by rule" : undefined,
  };
}
