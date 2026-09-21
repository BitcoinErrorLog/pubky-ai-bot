import { normalizePersonToken } from "./bot-kit/tags/denylist.js";
import { tagLabelMaxChars } from "./bot-kit/tags/policy.js";
import { RESOURCE_ENTITIES, slugifyPersonName } from "./resource-entities.js";
import { GIVEN_NAMES, GIVEN_NAMES_VERSION } from "./person-gazetteer-data/given-names.js";
import { PERSON_GAZETTEER_ABOUT_LABELS, PERSON_GAZETTEER_NOT_PEOPLE, PERSON_GAZETTEER_VERSION } from "./person-gazetteer.js";

/**
 * Tagger-wide person gate. Removes labels that name a person (author, guest,
 * executive, politician, handle) from any candidate label list, for every
 * source and for both rule and model labels. It never creates labels. Every
 * drop carries a reason code that the manifest records.
 */
export const PERSON_GATE_VERSION = `person-gate-v1/${PERSON_GAZETTEER_VERSION}/${GIVEN_NAMES_VERSION}`;

export type PersonGateReason =
  | "gazetteer-not-about"
  | "author-match"
  | "person-mention"
  | "given-name"
  | "nickname"
  | "handle"
  | "person-token"
  | "known-person"
  | "truncated";

export type PersonGateDrop = { label: string; reason: PersonGateReason; evidence?: string };
export type PersonGateResult = { labels: string[]; dropped: PersonGateDrop[]; version: string };
export type PersonGateRecord = { version: string; dropped: PersonGateDrop[] };

export type PersonEvidenceInput = {
  canonicalValue?: string;
  title?: string;
  description?: string;
  bodyText?: string;
  authors?: readonly string[];
  tagHints?: readonly string[];
  taxonomy?: { domain?: readonly string[] };
  metadata?: Record<string, unknown>;
};

type Mention = { nonInitial: boolean; honorific: boolean; verb: boolean; inList: boolean };

export type PersonEvidence = {
  hasBody: boolean;
  authors: string[];
  authorTokens: Set<string>;
  foldedWords: string[];
  lowerFlags: boolean[];
  lowerWords: Set<string>;
  mentions: Map<string, Mention>;
  personTokens: Set<string>;
  /** Last tokens of capitalised runs that start with a given name (`trump` from "Donald Trump"). */
  surnameTokens: Set<string>;
  nicknames: Set<string>;
  handles: Set<string>;
  profileSegments: Set<string>;
  titleNormalized: string;
  protected: Set<string>;
};

const HONORIFICS = new Set([
  "sen", "senator", "rep", "representative", "gov", "governor", "dr", "mr", "ms", "mrs", "judge", "justice",
  "ceo", "cto", "cfo", "coo", "founder", "cofounder", "co-founder", "developer", "analyst", "professor", "economist",
  "author", "host", "guest", "contributor", "maintainer", "researcher", "journalist", "strategist", "president",
  "secretary", "commissioner", "chairman", "chairwoman", "director", "attorney", "congressman", "congresswoman", "prof",
]);
const ATTRIBUTION_VERBS = new Set([
  "said", "says", "told", "wrote", "writes", "tweeted", "posted", "argued", "argues", "explained", "explains", "noted",
  "notes", "added", "replied", "asked", "testified", "stated", "warned", "warns", "claimed", "claims",
]);
const LIST_TRIGGERS = new Set(["by", "featuring", "feat", "guest", "guests", "speakers", "panelists", "hosts", "joined", "hosted"]);
const NAME_PARTICLES = new Set(["van", "von", "de", "di", "da", "del", "della", "la", "le", "du", "der", "den"]);
const NON_PERSON_ENTITY_IDS = new Set(RESOURCE_ENTITIES.filter((entity) => entity.kind !== "person").map((entity) => entity.id));
export const KNOWN_PERSON_LABELS: ReadonlySet<string> = new Set(
  RESOURCE_ENTITIES.filter((entity) => entity.kind === "person").flatMap((entity) => [
    entity.id,
    ...(entity.shortId ? [entity.shortId] : []),
    ...entity.aliases.map((alias) => slugifyPersonName(alias)),
  ]).filter(Boolean),
);
const DOMAIN_LABELS = ["bitcoin", "lightning", "liquid", "nostr", "music", "news", "software", "reference", "programming"];
const PROFILE_HOSTS: Record<string, (segments: string[]) => string | undefined> = {
  "t.me": (s) => s[0],
  "keybase.io": (s) => s[0],
  "nostr.directory": (s) => (s[0] === "p" ? s[1] : undefined),
  "twitter.com": (s) => s[0],
  "x.com": (s) => s[0],
  "github.com": (s) => s[0],
  "gitlab.com": (s) => s[0],
  "youtube.com": (s) => (s[0]?.startsWith("@") ? s[0].slice(1) : undefined),
  "medium.com": (s) => (s[0]?.startsWith("@") ? s[0].slice(1) : undefined),
  "unciphered.com": (s) => (s[0] === "friends" ? s[1] : undefined),
};
const FORGE_HOSTS = new Set(["github.com", "gitlab.com"]);
const NON_ACCOUNT_SEGMENTS = new Set(["i", "search", "hashtag", "home", "explore", "intent", "share", "s", "c", "channel", "watch", "orgs", "topics", "features"]);
const MAX_TEXT_CHARS = 20_000;
const TOKEN_RE = /[@#]?[\p{L}\p{N}][\p{L}\p{N}_’'.-]*|[.!?;:,&]/gu;

function foldName(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[’'`.]/g, "")
    .replace(/_/g, "-")
    .replace(/[^a-z0-9-]+/g, "")
    .replace(/^-+|-+$/g, "");
}

function stripQuotes(raw: string): string {
  return raw.replace(/^["“'‘]+|["”'’.,]+$/gu, "");
}

function squash(value: string): string {
  return value.replace(/[-_]/g, "");
}

function isCapitalized(word: string): boolean {
  const first = word.charAt(0);
  if (!/\p{Lu}/u.test(first)) return false;
  const rest = word.slice(1);
  if (!/\p{L}/u.test(rest)) return rest.length === 0;
  return rest !== rest.toUpperCase();
}

function isHandleShaped(word: string): boolean {
  return word.length >= 4 && /^[a-z0-9_]+$/.test(word) && (/_/.test(word) || /\d/.test(word));
}

function isTitleCase(title: string): boolean {
  const words = title.split(/\s+/).filter((word) => /^\p{L}/u.test(word));
  if (words.length < 3) return false;
  return words.filter(isCapitalized).length / words.length > 0.6;
}

function metadataStrings(value: unknown, depth = 0, out: string[] = []): string[] {
  if (depth > 3 || out.length > 200) return out;
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) metadataStrings(item, depth + 1, out);
  else if (value && typeof value === "object") for (const item of Object.values(value)) metadataStrings(item, depth + 1, out);
  return out;
}

function authorStrings(input: PersonEvidenceInput): string[] {
  const out = [...(input.authors ?? [])];
  const metadata = input.metadata ?? {};
  for (const key of ["authors", "author", "creator", "dc:creator", "contributors"]) {
    const value = metadata[key];
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) for (const item of value) if (typeof item === "string") out.push(item);
  }
  return [...new Set(out.map((author) => author.trim()).filter(Boolean))];
}

function nameTokens(raw: string): string[] {
  return raw.split(/[\s,]+/).map(foldName).filter((token) => token && !/^\d+$/.test(token));
}

/** An author string that looks like a person rather than a publication or organisation. */
function personLikeAuthor(tokens: readonly string[]): boolean {
  if (tokens.length === 1) return true;
  return tokens.length <= 4 && GIVEN_NAMES.has(tokens[0]!);
}

function labelTokens(label: string): string[] {
  return label.split("-").filter(Boolean);
}

function hasNumericToken(tokens: readonly string[]): boolean {
  return tokens.some((token) => /^\d/.test(token));
}

export function buildPersonEvidence(input: PersonEvidenceInput, protectedLabels: Iterable<string> = []): PersonEvidence {
  const title = input.title ?? "";
  const description = input.description ?? "";
  const body = (input.bodyText ?? "").slice(0, MAX_TEXT_CHARS);
  const metadataText = metadataStrings(input.metadata ?? {}).join("\n");
  const capSources = [isTitleCase(title) ? "" : title, description, body, metadataText];
  const fullText = [title, description, body, metadataText].join("\n");

  const foldedWords: string[] = [];
  const lowerFlags: boolean[] = [];
  const lowerWords = new Set<string>();
  for (const raw of fullText.match(TOKEN_RE) ?? []) {
    if (/^[.!?;:,&]$/.test(raw)) continue;
    const word = stripQuotes(raw);
    if (!word) continue;
    const folded = foldName(word);
    if (!folded) continue;
    const lower = word === word.toLowerCase() && /^[\p{Ll}]/u.test(word);
    foldedWords.push(folded);
    lowerFlags.push(lower);
    if (lower) lowerWords.add(folded);
  }

  const handles = new Set<string>();
  for (const match of fullText.matchAll(/(?:^|[\s(])@([A-Za-z0-9_.-]{2,40})/g)) handles.add(foldName(match[1]!));
  const nicknames = new Set<string>();
  const nicknamePairs: string[][] = [];
  for (const match of fullText.matchAll(/(\p{Lu}[\p{L}’'.-]+)\s+["“'‘]([A-Za-z0-9_][\w.-]{1,30})["”'’]\s+(\p{Lu}[\p{L}’'.-]+)/gu)) {
    nicknames.add(foldName(match[2]!));
    nicknamePairs.push([foldName(match[1]!), foldName(match[3]!)].filter(Boolean));
  }

  const authors = authorStrings(input);
  const authorTokens = new Set<string>();
  for (const author of authors) {
    const tokens = nameTokens(author);
    if (!personLikeAuthor(tokens)) continue;
    for (const token of tokens) if (token.length >= 4) authorTokens.add(token);
  }

  const mentions = new Map<string, Mention>();
  const personTokens = new Set<string>();
  const surnameTokens = new Set<string>();
  const merge = (key: string, flags: Mention): void => {
    const existing = mentions.get(key);
    mentions.set(key, existing
      ? { nonInitial: existing.nonInitial || flags.nonInitial, honorific: existing.honorific || flags.honorific, verb: existing.verb || flags.verb, inList: existing.inList || flags.inList }
      : flags);
  };
  const recordRun = (run: readonly string[], prev: string, next: string, sentenceStart: boolean, inList: boolean): void => {
    for (let size = 1; size <= 3; size += 1) {
      for (let start = 0; start + size <= run.length; start += 1) {
        const slice = run.slice(start, start + size);
        if (size === 1 && slice[0]!.length < 4) continue;
        const before = start === 0 ? prev : run[start - 1]!;
        const after = start + size === run.length ? next : "";
        const honorific = HONORIFICS.has(before);
        const nonInitial = inList || honorific || start > 0 || !sentenceStart;
        merge(slice.join("-"), { nonInitial, honorific, verb: ATTRIBUTION_VERBS.has(after), inList });
        if (size >= 2 && nonInitial && GIVEN_NAMES.has(slice[0]!) && slice[0]!.length >= 3) {
          const last = slice[size - 1]!;
          if (last.length >= 4 && !NAME_PARTICLES.has(last)) surnameTokens.add(last);
        }
      }
    }
  };

  // `Mark “Murch” Erhardt` names a person on both sides of the nickname.
  for (const pair of nicknamePairs) {
    if (pair.length !== 2) continue;
    recordRun(pair, "", "", false, true);
    for (const token of pair) if (token.length >= 4) personTokens.add(token);
  }

  for (const source of capSources) {
    if (!source) continue;
    const tokens = source.match(TOKEN_RE) ?? [];
    let sentenceStart = true;
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index]!;
      if (/^[.!?;:]$/.test(token)) {
        sentenceStart = true;
        continue;
      }
      if (token === "," || token === "&") continue;
      const clean = stripQuotes(token);
      if (!clean) continue;
      if (isCapitalized(clean)) {
        const run: string[] = [];
        let cursor = index;
        while (cursor < tokens.length) {
          const candidate = stripQuotes(tokens[cursor]!);
          if (!candidate) break;
          const particle = run.length > 0 && NAME_PARTICLES.has(candidate.toLowerCase())
            && cursor + 1 < tokens.length && isCapitalized(stripQuotes(tokens[cursor + 1]!));
          if (isCapitalized(candidate) || particle) {
            const folded = foldName(candidate);
            if (folded) run.push(folded);
            cursor += 1;
            continue;
          }
          break;
        }
        const prev = index > 0 ? foldName(stripQuotes(tokens[index - 1]!)) : "";
        const next = cursor < tokens.length ? foldName(stripQuotes(tokens[cursor]!)) : "";
        if (run.length > 0) recordRun(run, prev, next, sentenceStart, false);
        index = Math.max(index, cursor - 1);
        sentenceStart = false;
        continue;
      }
      const lower = clean.toLowerCase();
      if (LIST_TRIGGERS.has(lower)) {
        const elements: string[][] = [];
        let cursor = index + 1;
        if ((lower === "joined" || lower === "hosted") && tokens[cursor]?.toLowerCase() === "by") cursor += 1;
        let current: string[] = [];
        const flush = (): void => {
          if (current.length) elements.push(current);
          current = [];
        };
        while (cursor < tokens.length) {
          const raw = tokens[cursor]!;
          if (raw === "," || raw === "&") {
            flush();
            cursor += 1;
            continue;
          }
          if (/^[.!?;:]$/.test(raw)) break;
          const candidate = stripQuotes(raw);
          if (!candidate) break;
          const candidateLower = candidate.toLowerCase();
          if (isCapitalized(candidate) || isHandleShaped(candidateLower)) {
            const folded = foldName(candidate);
            if (folded) current.push(folded);
            cursor += 1;
            continue;
          }
          if (candidateLower === "and") {
            flush();
            cursor += 1;
            continue;
          }
          if (NAME_PARTICLES.has(candidateLower) && current.length) {
            current.push(candidateLower);
            cursor += 1;
            continue;
          }
          break;
        }
        flush();
        const anchored = elements.some((element) =>
          (element.length >= 2 && GIVEN_NAMES.has(element[0]!)) || (element.length === 1 && isHandleShaped(element[0]!)));
        if (anchored) {
          for (const element of elements) {
            const expanded = element.flatMap((token) => (token.includes("-") ? [token, ...token.split("-")] : [token]));
            recordRun(element, "", "", false, true);
            if (element.length === 1 && element[0]!.includes("-")) recordRun(element[0]!.split("-").filter(Boolean), "", "", false, true);
            for (const token of expanded) if (token.length >= 4 && !NAME_PARTICLES.has(token)) personTokens.add(token);
          }
        }
      }
      sentenceStart = false;
    }
  }

  let profileSegments = new Set<string>();
  if (input.canonicalValue && /^https?:/i.test(input.canonicalValue)) {
    try {
      const url = new URL(input.canonicalValue);
      const host = url.hostname.toLowerCase().replace(/^www\./, "");
      const resolver = PROFILE_HOSTS[host];
      const segments = url.pathname.split("/").filter(Boolean);
      const segment = resolver?.(segments);
      if (segment && !NON_ACCOUNT_SEGMENTS.has(segment.toLowerCase())) {
        const folded = foldName(segment);
        const givenPrefixed = [...GIVEN_NAMES].some((name) => name.length >= 3 && folded.length > name.length && folded.startsWith(name));
        if (!FORGE_HOSTS.has(host) || givenPrefixed || /\d$/.test(folded)) profileSegments = new Set([folded, squash(folded)]);
      }
    } catch {
      profileSegments = new Set();
    }
  }

  const protectedSet = new Set<string>([
    ...DOMAIN_LABELS,
    ...(input.taxonomy?.domain ?? []),
    ...(input.tagHints ?? []).map((hint) => hint.trim().toLowerCase()),
    ...NON_PERSON_ENTITY_IDS,
    ...protectedLabels,
  ]);
  for (const label of protectedSet) if (KNOWN_PERSON_LABELS.has(label)) protectedSet.delete(label);

  return {
    hasBody: body.trim().length > 0,
    authors,
    authorTokens,
    foldedWords,
    lowerFlags,
    lowerWords,
    mentions,
    personTokens,
    surnameTokens,
    nicknames,
    handles,
    profileSegments,
    titleNormalized: nameTokens(title).join(" "),
    protected: protectedSet,
  };
}

function authorMatch(label: string, evidence: PersonEvidence): string | undefined {
  const tokens = labelTokens(label);
  const squashedLabel = squash(label);
  for (const author of evidence.authors) {
    const normalized = normalizePersonToken(author);
    const folded = nameTokens(author);
    if (normalized === label || foldName(author) === squashedLabel || squash(normalized) === squashedLabel) return author;
    if (folded.length === 0 || !personLikeAuthor(folded)) continue;
    if (!tokens.every((token) => token.length >= 3)) continue;
    for (let start = 0; start + tokens.length <= folded.length; start += 1) {
      if (!tokens.every((token, offset) => folded[start + offset] === token)) continue;
      const covers = tokens.length >= 2 && tokens.length >= Math.ceil(folded.length / 2);
      const surname = tokens.length === 1 && start === folded.length - 1 && folded.length >= 2 && tokens[0]!.length >= 4;
      if (covers || surname) return author;
    }
  }
  return undefined;
}

function phraseAppearsLowercase(tokens: readonly string[], evidence: PersonEvidence): boolean {
  if (tokens.length === 1) return evidence.lowerWords.has(tokens[0]!);
  const { foldedWords, lowerFlags } = evidence;
  for (let start = 0; start + tokens.length <= foldedWords.length; start += 1) {
    if (tokens.every((token, offset) => foldedWords[start + offset] === token && lowerFlags[start + offset])) return true;
  }
  return false;
}

function truncationCheck(label: string, evidence: PersonEvidence): string | undefined {
  if (label.length !== tagLabelMaxChars()) return undefined;
  const tokens = labelTokens(label);
  const last = tokens.at(-1);
  if (!last || /^\d/.test(last)) return undefined;
  const words = evidence.foldedWords;
  if (words.includes(last) || evidence.authorTokens.has(last)) return undefined;
  const previous = tokens.length >= 2 ? tokens[tokens.length - 2]! : undefined;
  // Prefer the word that follows the label's penultimate token in the text ("Senate Banking Commi|ttee").
  if (previous) {
    for (let index = 0; index + 1 < words.length; index += 1) {
      if (words[index] === previous && words[index + 1]!.length > last.length && words[index + 1]!.startsWith(last)) return words[index + 1];
    }
  }
  if (last.length < 3) return undefined;
  return words.find((word) => word.length > last.length && word.startsWith(last));
}

export type PersonGateOptions = {
  /** Set false to prove the generic rules alone (dry-run diagnostics); production always uses the entity list. */
  useKnownPersons?: boolean;
};

export function applyPersonGate(labels: readonly string[], evidence: PersonEvidence, options: PersonGateOptions = {}): PersonGateResult {
  const useKnownPersons = options.useKnownPersons ?? true;
  const dropped: PersonGateDrop[] = [];
  const kept: string[] = [];
  const detectedTokens = new Set<string>([...evidence.personTokens, ...evidence.authorTokens, ...evidence.nicknames]);
  const exempt = (label: string): boolean => evidence.protected.has(label) || PERSON_GAZETTEER_NOT_PEOPLE.has(label);

  const decide = (label: string): PersonGateDrop | null => {
    if (PERSON_GAZETTEER_ABOUT_LABELS.has(label)) {
      const phrase = labelTokens(label).join(" ");
      return evidence.titleNormalized.includes(phrase) ? null : { label, reason: "gazetteer-not-about" };
    }
    if (exempt(label)) return null;
    const tokens = labelTokens(label);
    const truncated = truncationCheck(label, evidence);
    if (truncated) return { label, reason: "truncated", evidence: truncated };
    if (hasNumericToken(tokens)) return null;
    const author = authorMatch(label, evidence);
    if (author) return { label, reason: "author-match", evidence: author };
    if (evidence.handles.has(label) || evidence.handles.has(squash(label))) return { label, reason: "handle", evidence: "mention" };
    if (evidence.profileSegments.has(label) || evidence.profileSegments.has(squash(label))) return { label, reason: "handle", evidence: "profile-url" };
    if (useKnownPersons && KNOWN_PERSON_LABELS.has(label)) return { label, reason: "known-person" };
    if (evidence.nicknames.has(label) || evidence.nicknames.has(squash(label))) return { label, reason: "nickname" };
    const mention = evidence.mentions.get(label);
    if (tokens.length >= 2 && tokens.length <= 3) {
      const givenName = tokens[0]!.length >= 3 && GIVEN_NAMES.has(tokens[0]!);
      const lowercase = phraseAppearsLowercase(tokens, evidence);
      if (mention && !lowercase && (mention.honorific || mention.verb || mention.inList)) {
        return { label, reason: "person-mention", evidence: mention.inList ? "list" : mention.honorific ? "honorific" : "attribution" };
      }
      if (givenName) {
        if (!evidence.hasBody) return { label, reason: "given-name", evidence: "no-body" };
        if (mention?.nonInitial && !lowercase) return { label, reason: "given-name", evidence: "capitalised-mention" };
        if (!lowercase) return { label, reason: "given-name", evidence: "no-lowercase-use" };
      }
      return null;
    }
    if (tokens.length === 1) {
      const token = tokens[0]!;
      if (token.length < 4 || evidence.lowerWords.has(token)) return null;
      if (mention?.honorific) return { label, reason: "person-mention", evidence: "honorific" };
      if (detectedTokens.has(token)) return { label, reason: "person-token" };
      if (evidence.surnameTokens.has(token)) return { label, reason: "person-token", evidence: "surname-of-mention" };
    }
    return null;
  };

  for (const raw of labels) {
    const label = raw.trim().toLowerCase();
    if (!label) continue;
    const drop = decide(label);
    if (drop) {
      dropped.push(drop);
      if (drop.reason !== "truncated") {
        for (const token of labelTokens(label)) if (token.length >= 4 && !evidence.lowerWords.has(token)) detectedTokens.add(token);
      }
      continue;
    }
    kept.push(label);
  }
  // Second pass: a single token of a name detected above (`trump` beside `donald-trump`).
  const final: string[] = [];
  for (const label of kept) {
    const tokens = labelTokens(label);
    if (tokens.length === 1 && tokens[0]!.length >= 4 && !exempt(label) && !PERSON_GAZETTEER_ABOUT_LABELS.has(label)
      && !evidence.lowerWords.has(tokens[0]!) && detectedTokens.has(tokens[0]!)) {
      dropped.push({ label, reason: "person-token" });
      continue;
    }
    final.push(label);
  }
  return { labels: final, dropped, version: PERSON_GATE_VERSION };
}

export function personGateDenials(dropped: readonly PersonGateDrop[], denials: Record<string, number>): void {
  for (const drop of dropped) {
    const key = `person-gate:${drop.reason}`;
    denials[key] = (denials[key] ?? 0) + 1;
  }
}

export function gateResourceLabels(labels: readonly string[], input: PersonEvidenceInput, protectedLabels: Iterable<string> = []): PersonGateResult {
  return applyPersonGate(labels, buildPersonEvidence(input, protectedLabels));
}
