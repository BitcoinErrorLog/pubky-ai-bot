import { log } from "./log.js";

export interface InjectionDetection {
  detected: boolean;
  patterns: string[];
  sanitized: string;
}

export class InjectionDetector {
  private static readonly PATTERNS = {
    instructionOverride: /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|directives?)/i,
    roleManipulation: /(you\s+are\s+now|act\s+as|pretend\s+to\s+be)\s+(a|an)\s+\w+/i,
    contextBreaking: /---+\s*(end|start|new|system)|===+\s*(end|start|new)/i,
    systemReference: /\[(system|user|assistant|context)\]|<\|(system|user|end)\|>/i,
    dataExfiltration: /repeat\s+(your|the)\s+(instructions?|prompt|system)/i,
    jailbreak: /(developer|debug|admin)\s+mode|jailbreak|bypass\s+safety/i,
  };

  detect(
    content: string,
    context?: { mentionId?: string; postId?: string; authorId?: string; postUri?: string },
  ): InjectionDetection {
    const normalized = this.normalize(content);
    const detectedPatterns: string[] = [];
    for (const [category, pattern] of Object.entries(InjectionDetector.PATTERNS)) {
      if (pattern.test(normalized)) detectedPatterns.push(category);
    }
    const detected = detectedPatterns.length > 0;
    if (detected) this.logDetection(detectedPatterns, context);
    return { detected, patterns: detectedPatterns, sanitized: this.sanitize(normalized, detected) };
  }

  private normalize(text: string): string {
    let normalized = text.normalize("NFKC");
    normalized = normalized.replace(/[\u200B-\u200D\uFEFF]/g, "");
    normalized = normalized.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, "");
    return normalized;
  }

  private sanitize(text: string, hasInjection: boolean): string {
    if (!hasInjection) return text;
    let sanitized = text
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
