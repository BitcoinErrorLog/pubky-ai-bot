/**
 * Deterministic voice linter (docs/voice.md). Mechanical rules only:
 * it never rewrites meaning, it strips or flags a fixed set of
 * anti-patterns so voice drift is measurable in production via the
 * violations recorded in the evidence bundle.
 */

export const VOICE_RULES = [
  "forbidden_opener",
  "ai_disclaimer",
  "throat_clearing",
  "exclamation_run",
  "exclamation_density",
  "emoji",
  "citation_cap",
  "markdown_emphasis",
  "labelling_meta",
  "length_target",
] as const;

export type VoiceRule = (typeof VOICE_RULES)[number];

export interface VoiceViolation {
  rule: VoiceRule;
  detail: string;
}

export interface VoiceLintResult {
  text: string;
  violations: VoiceViolation[];
}

export const SHORT_REPLY_CITATION_CAP = 3;
export const SOURCES_MODE_CITATION_CAP = 8;
export const EXCLAMATION_CAP = 2;
export const SHORT_LENGTH_TARGET_MIN = 600;
export const SHORT_LENGTH_TARGET_MAX = 900;

const LABELLING_META: RegExp[] = [
  /\bdemo label is mine[^.!?\n]*[.!?]?\s*/gi,
  /\byour position, per\b[^.!?\n]*[.!?]?\s*/gi,
  /\btreat \S+ as planned[^.!?\n]*[.!?]?\s*/gi,
];

const OPENERS: RegExp[] = [
  /^\s*(great|good|nice|excellent|awesome|amazing|fantastic|wonderful|brilliant)\s+(question|point|one)[!.,:;]?\s*/i,
  /^\s*(sure|certainly|of course|absolutely|definitely)[,!.\s]\s*/i,
  /^\s*(i['’]?d be happy to|i would be happy to|happy to help|glad to help|i can help with that)[^.!?\n]*[.!?]?\s*/i,
  /^\s*(hello|hi|hey|greetings)[,!.\s]\s*/i,
];

/** Phrases stripped wherever they appear; a following lowercase letter at a
 * sentence start is re-capitalized (captured as group 1). */
const STRIP_PHRASES: Array<{ rule: VoiceRule; rx: RegExp }> = [
  { rule: "ai_disclaimer", rx: /\bas an ai\b[^.!?\n]*[.!?]?\s*([a-z])?/gi },
  { rule: "throat_clearing", rx: /\bin conclusion[,]?\s*([a-z])?/gi },
  { rule: "throat_clearing", rx: /\bit['’]?s important to note that\s*([a-z])?/gi },
  { rule: "throat_clearing", rx: /\bit is important to note that\s*([a-z])?/gi },
  { rule: "throat_clearing", rx: /\bit['’]?s worth noting that\s*([a-z])?/gi },
  { rule: "throat_clearing", rx: /\bit is worth noting that\s*([a-z])?/gi },
  { rule: "throat_clearing", rx: /\bneedless to say[,]?\s*([a-z])?/gi },
  { rule: "throat_clearing", rx: /\bit goes without saying that\s*([a-z])?/gi },
  { rule: "throat_clearing", rx: /\bi hope this helps[^.!?\n]*[.!?]?\s*([a-z])?/gi },
  { rule: "throat_clearing", rx: /\blet me know if you (need|have) any[^.!?\n]*[.!?]?\s*([a-z])?/gi },
];

const EMOJI = /[\p{Extended_Pictographic}\u200D\uD83C\uDFFB-\uD83C\uDFFF\u20E3\uFE0E\uFE0F]/gu;

const CITATION = /\b(?:pubky:\/\/[a-z0-9]{52}[^\s)]*|https?:\/\/[^\s)]+)/gi;

export function lintVoice(
  text: string,
  opts?: {
    citationCap?: number;
    lengthTarget?: { min: number; max: number };
    /** Skip markdown_emphasis. For long articles rendered as Markdown, not replies. */
    allowMarkdown?: boolean;
  },
): VoiceLintResult {
  const violations: VoiceViolation[] = [];
  let out = text;

  // Forbidden openers: restart the scan after every strip so stacked
  // openers ("Hello! Sure, I'd be happy to help.") all come off.
  let strippedOpener = false;
  for (;;) {
    let progressed = false;
    for (const opener of OPENERS) {
      const m = opener.exec(out);
      if (m) {
        violations.push({ rule: "forbidden_opener", detail: m[0].trim() });
        out = out.slice(m[0].length);
        strippedOpener = true;
        progressed = true;
      }
    }
    if (!progressed) break;
  }

  for (const { rule, rx } of STRIP_PHRASES) {
    out = out.replace(rx, (m, next: string | undefined, offset: number, whole: string) => {
      violations.push({ rule, detail: m.trim() });
      if (next && (offset === 0 || /[.!?]\s*$/.test(whole.slice(0, offset)))) {
        return next.toUpperCase();
      }
      return next ?? "";
    });
  }

  out = out.replace(/!{2,}/g, (m) => {
    violations.push({ rule: "exclamation_run", detail: m });
    return "!";
  });
  const bangs = out.split("").reduce((n, c) => n + (c === "!" ? 1 : 0), 0);
  if (bangs > EXCLAMATION_CAP) {
    let seen = 0;
    out = out.replace(/!/g, () => {
      seen += 1;
      if (seen > EXCLAMATION_CAP) {
        violations.push({ rule: "exclamation_density", detail: `exclamation ${seen} of ${bangs}` });
        return ".";
      }
      return "!";
    });
  }

  out = out.replace(EMOJI, (m) => {
    violations.push({ rule: "emoji", detail: m });
    return "";
  });

  const cap = opts?.citationCap ?? SHORT_REPLY_CITATION_CAP;
  let cited = 0;
  out = out.replace(CITATION, (m) => {
    cited += 1;
    if (cited > cap) {
      violations.push({ rule: "citation_cap", detail: `dropped citation ${cited} (cap ${cap}): ${m}` });
      return "";
    }
    return m;
  });

  if (!opts?.allowMarkdown) {
    out = stripMarkdownEmphasis(out, violations);
  }

  for (const rx of LABELLING_META) {
    rx.lastIndex = 0;
    out = out.replace(rx, (m) => {
      violations.push({ rule: "labelling_meta", detail: m.trim() });
      return " ";
    });
  }

  out = tidyWhitespace(out);
  if (strippedOpener) out = capitalizeFirst(out);

  const target = opts?.lengthTarget;
  if (target) {
    const n = out.length;
    if (n < target.min || n > target.max) {
      violations.push({
        rule: "length_target",
        detail: `${n} chars (soft target ${target.min}–${target.max})`,
      });
    }
  }

  return { text: out, violations };
}

function stripMarkdownEmphasis(text: string, violations: VoiceViolation[]): string {
  let out = text;
  out = out.replace(/\*\*([^*]+)\*\*/g, (_m, inner: string) => {
    violations.push({ rule: "markdown_emphasis", detail: "**" });
    return inner;
  });
  out = out.replace(/__([^_]+)__/g, (_m, inner: string) => {
    violations.push({ rule: "markdown_emphasis", detail: "__" });
    return inner;
  });
  out = out.replace(/^#{1,6}\s+/gm, () => {
    violations.push({ rule: "markdown_emphasis", detail: "#" });
    return "";
  });
  if (/\*\*|__/.test(out)) {
    violations.push({ rule: "markdown_emphasis", detail: "unpaired" });
    out = out.replace(/\*\*/g, "").replace(/__/g, "");
  }
  return out;
}

function tidyWhitespace(text: string): string {
  return text
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +([.,!?;:])/g, "$1")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function capitalizeFirst(text: string): string {
  if (/^[a-z]/.test(text) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    return text[0].toUpperCase() + text.slice(1);
  }
  return text;
}

export interface VoiceEvalRuleHit {
  rule: string;
  item: string;
}

/** Apply a list of forbidden regexes (from eval/voice YAML) to a reply. */
export function forbiddenHits(text: string, patterns: Array<{ name: string; pattern: string }>, item: string): VoiceEvalRuleHit[] {
  const hits: VoiceEvalRuleHit[] = [];
  for (const p of patterns) {
    let rx: RegExp;
    try {
      rx = new RegExp(p.pattern, "imsu");
    } catch {
      hits.push({ rule: `${p.name} (invalid regex)`, item });
      continue;
    }
    if (rx.test(text)) hits.push({ rule: p.name, item });
  }
  return hits;
}
