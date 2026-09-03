export type AnswerMode = "short" | "deep" | "sources";

export function parseModes(text: string): Set<AnswerMode> {
  const modes = new Set<AnswerMode>();
  const t = text.toLowerCase();
  if (/\bdeep\b/.test(t) || /\blong form\b/.test(t)) modes.add("deep");
  if (/\bsources?\b/.test(t) || /\bcite\b/.test(t)) modes.add("sources");
  if (/\bshort\b/.test(t) || /\btldr\b/.test(t)) modes.add("short");
  if (modes.size === 0) modes.add("short");
  return modes;
}
