export type AnswerMode = "short" | "deep" | "sources" | "pubky_only";

const DEEP = /\bdeep\b|\bin depth\b|\bin-depth\b|\blong[\s-]?form\b|\bfull answer\b|\bgo deep\b|\bdetailed\b/i;
const SOURCES = /\bsources?\b|\bcite\b|\bcitations?\b|\breferences?\b|\bshow (me )?(your )?sources\b/i;
const SHORT = /\bshort\b|\btldr\b|\btl;dr\b|\bbrief\b|\bkeep it (short|brief)\b|\bconcise\b|\bin one sentence\b/i;
const PUBKY_ONLY =
  /\bjust (the )?pubky\b|\bpubky[ -]only\b|\bonly (the )?pubky\b|\bpubky part\b|\bstay on pubky\b|\bpubky network only\b/i;

export function parseModes(text: string): Set<AnswerMode> {
  const modes = new Set<AnswerMode>();
  const t = text.toLowerCase();
  if (DEEP.test(t)) modes.add("deep");
  if (SOURCES.test(t)) modes.add("sources");
  if (SHORT.test(t)) modes.add("short");
  if (PUBKY_ONLY.test(t)) modes.add("pubky_only");
  if (modes.size === 0) modes.add("short");
  return modes;
}
