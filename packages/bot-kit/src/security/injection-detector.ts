import { log } from "../log.js";

const LATIN_CONFUSABLES: Record<string, string> = {
  а: "a",
  е: "e",
  о: "o",
  р: "p",
  с: "c",
  у: "y",
  х: "x",
  і: "i",
  ј: "j",
  ο: "o",
  α: "a",
};

export function normalizeForMatching(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[аерсухіјοα]/g, (character) => LATIN_CONFUSABLES[character] ?? character)
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function detectedImperativeCount(text: string): number {
  return [
    InjectionDetector.PATTERNS.instructionOverride,
    InjectionDetector.PATTERNS.roleManipulation,
    InjectionDetector.PATTERNS.dataExfiltration,
    InjectionDetector.PATTERNS.jailbreak,
  ].reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);
}

function removeAll(text: string, pattern: RegExp): string {
  return text.replace(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`), "[removed]");
}

export interface InjectionDetection {
  detected: boolean;
  patterns: string[];
  sanitized: string;
}

export class InjectionDetector {
  static readonly PATTERNS = {
    instructionOverride: /(ignore|disregard|override|forget)\s+(?:(?:all|the|your|any|previous|prior|above|these)\s+)*(rules?|instructions?|directives?|guidelines?|polic(?:y|ies)|prompts?)/i,
    roleManipulation: /(you\s+are\s+now|act\s+as|pretend\s+to\s+be)\s+(a|an)\s+\w+/i,
    contextBreaking: /---+\s*(end|start|new|system)|===+\s*(end|start|new)/i,
    systemReference: /\[(system|user|assistant|context)\]|<\|(system|user|end)\|>/i,
    dataExfiltration: /repeat\s+(your|the)\s+(instructions?|prompt|system)/i,
    jailbreak: /(developer|debug|admin)\s+mode|jailbreak|bypass\s+safety/i,
  };

  detect(
    content: string,
    context?: { mentionId?: string; postId?: string; authorId?: string; postUri?: string },
    opts?: { sanitize?: boolean },
  ): InjectionDetection {
    const normalized = this.normalize(content);
    const detectedPatterns: string[] = [];
    for (const [category, pattern] of Object.entries(InjectionDetector.PATTERNS)) {
      if (pattern.test(normalized)) detectedPatterns.push(category);
    }
    const detected = detectedPatterns.length > 0;
    if (detected) this.logDetection(detectedPatterns, context);
    return { detected, patterns: detectedPatterns, sanitized: this.sanitize(normalized, detected, opts?.sanitize ?? false) };
  }

  private normalize(text: string): string {
    let normalized = text.normalize("NFKC");
    normalized = normalized.replace(/[\u200B-\u200D\uFEFF]/g, "");
    normalized = normalized.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, "");
    normalized = normalized.normalize("NFD").replace(/\p{M}/gu, "");
    normalized = normalized.replace(/[АаЕеОоРрСсУуХхІіЈјΟοΑα]/g, (character) => LATIN_CONFUSABLES[character.toLocaleLowerCase("en-US")] ?? character);
    return normalized;
  }

  private sanitize(text: string, hasInjection: boolean, removeImperatives: boolean): string {
    if (!hasInjection) return text;
    let sanitized = (
      removeImperatives
        ? [InjectionDetector.PATTERNS.instructionOverride, InjectionDetector.PATTERNS.roleManipulation, InjectionDetector.PATTERNS.dataExfiltration, InjectionDetector.PATTERNS.jailbreak].reduce(
            (value, pattern) => removeAll(value, pattern),
            text,
          )
        : text
            .replace(InjectionDetector.PATTERNS.instructionOverride, "$&")
            .replace(InjectionDetector.PATTERNS.roleManipulation, "$&")
            .replace(InjectionDetector.PATTERNS.dataExfiltration, "$&")
            .replace(InjectionDetector.PATTERNS.jailbreak, "$&")
    )
      .replace(/═{3,}/g, "---")
      .replace(/━{3,}/g, "---")
      .replace(/\[SYSTEM\]/gi, "[filtered]")
      .replace(/\[USER\]/gi, "[filtered]")
      .replace(/\[ASSISTANT\]/gi, "[filtered]")
      .replace(/<\|system\|>/gi, "[filtered]")
      .replace(/<\|user\|>/gi, "[filtered]")
      .replace(/<\|end\|>/gi, "[filtered]");
    sanitized = sanitized.replace(/\n{3,}/g, "\n\n");
    sanitized = sanitized.replace(/[ \t]+/g, " ");
    if (sanitized.length > 10000) sanitized = sanitized.substring(0, 10000) + "...[truncated]";
    if (removeImperatives) log.info({ event: "prompt_injection_segments_removed", count: detectedImperativeCount(text) });
    return sanitized.trim();
  }

  private logDetection(
    patterns: string[],
    context?: { mentionId?: string; postId?: string; authorId?: string; postUri?: string },
  ): void {
    const pubkyLink = context?.postUri
      ? `https://app.pubky.org/thread/${encodeURIComponent(context.postUri)}`
      : undefined;
    log.info({
      event: "prompt_injection_detected",
      mention_id: context?.mentionId,
      post_id: context?.postId,
      author_id: context?.authorId,
      post_uri: context?.postUri,
      pubky_link: pubkyLink,
      patterns_detected: patterns,
    });
  }

  detectBatch(
    items: Array<{ content: string; id: string; authorId: string; uri?: string }>,
  ): Array<{ id: string; detected: boolean; patterns: string[]; sanitized: string }> {
    return items.map((item) => {
      const result = this.detect(item.content, { postId: item.id, authorId: item.authorId, postUri: item.uri });
      return { id: item.id, detected: result.detected, patterns: result.patterns, sanitized: result.sanitized };
    });
  }
}
